# Spec 03 — identity

Status: **v1.2 APPROVED (2026-10-08).** Approved by the user. v1.1: Phase 1 implementation clarifications (§7.1, I-1…I-9). v1.2: §4.11 index reference (DB-Q6). Changes from now on need explicit approval and a version bump.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Authentication identity only (G12): accounts, credentials, email verification, sessions (refresh tokens), password reset, invites, admin accounts.
Tables: `users`, `refresh_tokens`, `verification_codes`.
Not here: role profiles (`customers`, `sellers`, `delivery_agents` belong to their modules). **Self-registration endpoints are owned by `customers` and `sellers`**, which call `identity.createPendingUser` in their own transaction. This keeps `identity` free of dependencies on the profile modules (it calls no other module).

Enums:
- `UserStatus`: `pending_email_verification, invited, active, suspended`
- `VerificationPurpose`: `email_verification, password_reset, account_invite`

Config (env, no defaults): `OTP_TTL_MINUTES` (proposed 10), `OTP_MAX_ATTEMPTS` (5), `OTP_RESEND_COOLDOWN_SECONDS` (60), `INVITE_TTL_HOURS` (72), `INVITE_URL_BASE` (app deep link), `ACCESS_TOKEN_TTL_MINUTES` (15), `REFRESH_TOKEN_TTL_DAYS` (30), `BCRYPT_COST`, JWT key pair + `kid`, `JWT_ISSUER`, `JWT_AUDIENCE`, `SECRETS_ENCRYPTION_KEYS`, `SECRETS_ENCRYPTION_ACTIVE_KEY_ID` (S-1).

Every `notification.email_requested` this module writes puts the OTP / invite URL only in `encryptedSecrets` (`02-events.md` §3.1), never in `variables`.

## 2. Public API (`index.ts`)

Every write method takes `trx` and uses it.

| Method | Used by | Notes |
|---|---|---|
| `createPendingUser({ email, password, role }, trx) → { userId }` | customers, sellers | Hashes the password, `status = pending_email_verification`, issues an email-verification OTP + `notification.email_requested`. Throws `EMAIL_ALREADY_REGISTERED` |
| `createInvitedUser({ email, role }, trx) → { userId }` | delivery (agents), identity itself (admins) | `status = invited`, `password_hash = null`, issues an invite token + email |
| `getUsersByIds(ids) → UserSummary[]` | customers, sellers, delivery | `{ id, email, role, status, emailVerifiedAt }`, batched |
| `setUserStatus(userId, 'active' \| 'suspended', actorUserId, trx)` | delivery (agent deactivation, S-10) | Suspending revokes all of the user's refresh tokens. Only `active ⇄ suspended` (I-6). No role restriction here (the admin endpoints add one, I-5). Errors: `USER_NOT_FOUND`, `USER_INVALID_STATUS_TRANSITION` |

## 3. Use cases

### UC-ID-1 Verify email
1. Find the user by email with `status = pending_email_verification` and the latest unconsumed `email_verification` code.
2. If any is missing, expired, or `attempts >= OTP_MAX_ATTEMPTS` → `INVALID_OTP` (one generic code, so the response doesn't reveal whether the account exists).
3. Compare SHA-256(otp) with `code_hash` in constant time. Wrong → `attempts + 1` (conditional update) → `INVALID_OTP`.
4. One transaction: consume the code, `status = active`, `email_verified_at = now()`, create a refresh-token family.
5. Respond with a token pair (the user is logged in straight after verifying).

### UC-ID-2 Resend verification OTP
Always answers `200` with the same body. Work is done only when the user exists, is `pending_email_verification`, and the last code is older than `OTP_RESEND_COOLDOWN_SECONDS`. A new code invalidates older ones (only the latest unconsumed code is accepted, architecture §10). The user row is locked (`FOR UPDATE`) while the cooldown is checked, so concurrent requests send one code (I-3).

### UC-ID-3 Login
1. Look up by email. If the user is missing or `invited` (no password), still run `bcrypt.compare` against a fixed dummy hash, so the response time doesn't reveal it → `INVALID_CREDENTIALS`.
2. Wrong password → `INVALID_CREDENTIALS`.
3. Correct password and `pending_email_verification` → `EMAIL_NOT_VERIFIED`. `suspended` → `ACCOUNT_SUSPENDED`. These are returned only after a correct password, so they don't enable enumeration.
4. New refresh-token family, `last_login_at = now()`, token pair.
- Sellers in `pending_approval` / `rejected` / `suspended` **can** log in (they need to see their status and finish open orders, Q-36). Business status is enforced by the sellers module.

### UC-ID-4 Refresh (rotation + reuse detection)
1. SHA-256 the token and find it in `refresh_tokens`. Unknown or expired → `INVALID_REFRESH_TOKEN`.
2. Already revoked (reuse) → revoke the **whole family**, log `warn` (`event: REFRESH_TOKEN_REUSE`, userId, familyId) → `INVALID_REFRESH_TOKEN`.
3. User not `active` → revoke the family → `INVALID_REFRESH_TOKEN`.
4. One transaction: `UPDATE … SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL` (0 rows = a concurrent use → treat as reuse, step 2), insert the new token (same family), set `replaced_by_id`.
- No grace window in R1: the mobile app must serialise refresh calls.

### UC-ID-5 Logout
Revokes the presented refresh token's family (this device's session). Always `204`, even for an unknown token.

### UC-ID-6 Forgot / reset password
- Forgot: always `200`, same body. For an `active` user (cooldown as UC-ID-2), issue a `password_reset` OTP + email.
- Reset: the account must be `active` (as for forgot), otherwise `INVALID_OTP` (I-2). Verify the OTP like UC-ID-1 (`INVALID_OTP`). The new password is hashed **before** the transaction (I-4). One transaction: new hash, consume the code, **revoke all refresh tokens** of the user. `204`. The user then logs in.

### UC-ID-7 Admin invites (admins and agents)
- An admin creates another admin: `createInvitedUser(role = admin)`. Delivery agents are created by the delivery module (spec 11), which calls the same method.
- Accept invite: find an unconsumed, unexpired `account_invite` code by `code_hash` → set the password, `status = active`, `email_verified_at = now()` (the email link proves ownership), consume the code, token pair.
- Resend invite: only for `status = invited`. A new token invalidates the old one.

### UC-ID-8 Seed the first admin (CLI)
`npm run seed:admin -- --email <email>` (= `node dist/seed-admin.js --email <email>`) creates an `invited` admin and writes the invite email to the outbox. Refuses an invalid or existing email (exit code 1). Never prints the token. Needs only the DB and secrets-encryption env (`seedAdminEnvSchema`): no bcrypt, Redis or broker.

## 4. Endpoints

### 4.1 Shared response DTOs
```ts
interface AuthTokensDto {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string; role: UserRole; status: UserStatus };
}
interface MessageDto { message: string }   // generic, same text for every outcome
```

### 4.2 `POST /auth/email/verify`   auth: public · rate: strict-auth · idem: –
| field | rules |
|---|---|
| email | `email` |
| otp | `otp` |

`200 AuthTokensDto`. Errors: `INVALID_OTP` 400.

### 4.3 `POST /auth/email/resend-otp`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| email | `email` |

`200 MessageDto`. No domain errors (generic answer).

### 4.4 `POST /auth/login`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| email | `email` |
| password | `str(1..)` + `@MaxBytes(72)` (no policy check on login) |
| deviceName | `opt`, `str(1..100)`. Stored as `refresh_tokens.user_agent` for session auditing |

`200 AuthTokensDto`. Errors: `INVALID_CREDENTIALS` 401, `EMAIL_NOT_VERIFIED` 403, `ACCOUNT_SUSPENDED` 403.

### 4.5 `POST /auth/refresh`   auth: public · rate: refresh
| field | rules |
|---|---|
| refreshToken | `str(43..43)` (base64url of 32 bytes) |

`200 AuthTokensDto`. Errors: `INVALID_REFRESH_TOKEN` 401.

### 4.6 `POST /auth/logout`   auth: public (the access token may already be expired) · rate: refresh
| field | rules |
|---|---|
| refreshToken | `str(43..43)` |

`204`.

### 4.7 `POST /auth/password/forgot`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| email | `email` |

`200 MessageDto`.

### 4.8 `POST /auth/password/reset`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| email | `email` |
| otp | `otp` |
| newPassword | `password` |

`204`. Errors: `INVALID_OTP` 400.

### 4.9 `POST /auth/invite/accept`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| token | `str(43..43)` |
| password | `password` |

`200 AuthTokensDto`. Errors: `INVALID_INVITE_TOKEN` 400.

### 4.9b `POST /auth/password/change`   auth: any authenticated role · rate: strict-auth (IP + the account's email) · idem: – (S-19)
| field | rules |
|---|---|
| currentPassword | `str(1..)` + `@MaxBytes(72)` |
| newPassword | `password`; must differ from `currentPassword` |
| refreshToken | `str(43..43)`: the caller's current session, which is kept |

Steps: verify `currentPassword` (bcrypt) and hash `newPassword` **outside** the transaction (I-4). Then one transaction: check that `refreshToken` is a live session of this user, replace the hash **only if it is still the one that was verified** (a concurrent change makes the second one fail with `INVALID_CURRENT_PASSWORD`), and **revoke every refresh-token family of the user except the one `refreshToken` belongs to**. `204`.
Errors, checked in this order: `INVALID_CURRENT_PASSWORD` 400, `PASSWORD_UNCHANGED` 422, `INVALID_REFRESH_TOKEN` 401 (the token doesn't belong to this user or isn't active; also returned when the account itself is no longer `active`, I-7).
Rate limit: the `email:` counter is the same one login uses for that address, so failed attempts here and at login share one budget. The email is looked up from the token's user id (I-8).

### 4.10 `POST /admin/admins`   auth: admin · rate: general
| field | rules |
|---|---|
| email | `email` |

`201 { id: string; email: string; role: 'admin'; status: 'invited'; createdAt: string }`. Errors: `EMAIL_ALREADY_REGISTERED` 409.

### 4.11 `GET /admin/admins`   auth: admin
Whitelist: `status` (enum, `eq,in`), `createdAt` (date, `gte,lte`, sort: yes). Default sort `-createdAt`.
`200 { id, email, status, emailVerifiedAt, lastLoginAt, createdAt }[]` + meta.
Query: `WHERE role = 'admin'` + filters, ordered by `(created_at, id)`, served by `idx_users_role_created_at` (DB-Q6, `02-database.md` v1.4).

### 4.12 `POST /admin/users/:userId/resend-invite`   auth: admin
Params: `userId` `uuid`. `204`. Errors: `USER_NOT_FOUND` 404, `USER_NOT_INVITED` 409.

### 4.13 `POST /admin/users/:userId/suspend` · `POST /admin/users/:userId/reactivate`   auth: admin (S-2)
Params: `userId` `uuid`. Body (suspend only): `reason` `str(3..500)`.
`200 { id, email, role, status }`. Errors: `USER_NOT_FOUND` 404, `USER_INVALID_STATUS_TRANSITION` 409, `CANNOT_SUSPEND_SELF` 409.
Only customers and admins (S-2): a seller or delivery agent → `USER_INVALID_STATUS_TRANSITION` 409 (agents go through deactivation, S-10; sellers through seller suspension, spec 05, which doesn't block login) (I-5).
Transitions: suspend `active → suspended` (revokes every session), reactivate `suspended → active`. Invited or unverified accounts can't be suspended (I-6).
`reason` has no column: it is written to the `USER_SUSPENDED` audit log line with `userId` and `actorUserId` (I-9).

## 5. Events

Published: `notification.email_requested` (registration OTP, resend, forgot password, invite, resend invite).
Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `EMAIL_ALREADY_REGISTERED` | 409 | `uq_users_email` |
| `INVALID_CREDENTIALS` | 401 | Unknown email, wrong password, or invited account |
| `EMAIL_NOT_VERIFIED` | 403 | Correct password, email not verified |
| `ACCOUNT_SUSPENDED` | 403 | Correct password, user suspended |
| `INVALID_OTP` | 400 | Missing/expired/consumed/wrong OTP, or too many attempts |
| `INVALID_REFRESH_TOKEN` | 401 | Unknown, expired, revoked or reused token |
| `INVALID_INVITE_TOKEN` | 400 | Unknown, expired or consumed invite |
| `INVALID_CURRENT_PASSWORD` | 400 | Password change with a wrong current password |
| `PASSWORD_UNCHANGED` | 422 | New password equals the current one |
| `USER_NOT_FOUND` | 404 | Admin action on a missing user |
| `USER_NOT_INVITED` | 409 | Resend invite for a user who isn't `invited` |
| `USER_INVALID_STATUS_TRANSITION` | 409 | e.g. suspend an already suspended user, suspend an invited/unverified account, or use §4.13 on a seller or delivery agent |
| `CANNOT_SUSPEND_SELF` | 409 | Admin suspends their own account |

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.

- **S-1** Secret email variables are encrypted in the outbox (`02-events.md` §3.1).
- **S-2** Admin suspend/reactivate is in R1 (§4.13).
- **S-16** OTP 10 min, 5 attempts, 60 s cooldown · invite 72 h · access 15 min · refresh 30 days.
- **S-19** Change password while logged in is in R1 (§4.9b).

### 7.1 Implementation clarifications (v1.1, Phase 1, 2026-10-08)

Choices made where the text above was silent, accepted by the user when Phase 1 was committed.

| # | Clarification | Where |
|---|---|---|
| I-1 | Passwords are never trimmed (DTO shorthand `password`, `01-api-conventions.md` v1.1) | §4 |
| I-2 | Password reset requires an `active` account (as forgot does); otherwise `INVALID_OTP` | UC-ID-6 |
| I-3 | Resend OTP and forgot password lock the user row while checking the cooldown, so concurrent requests send one code | UC-ID-2, UC-ID-6 |
| I-4 | bcrypt runs outside DB transactions (reset, invite accept, change password), so a slow hash never holds a row lock. A wrong OTP/token still costs one hash; those routes are rate limited | UC-ID-6, UC-ID-7, §4.9b |
| I-5 | Admin suspend/reactivate applies to customers and admins only; sellers and agents → `USER_INVALID_STATUS_TRANSITION`. `setUserStatus` (public API) has no role restriction | §2, §4.13 |
| I-6 | Status changes are only `active ⇄ suspended` | §2, §4.13 |
| I-7 | Change password on an account that is no longer `active` → `INVALID_REFRESH_TOKEN` (its sessions are revoked anyway) | §4.9b |
| I-8 | Change-password rate limit: IP + the account email looked up from the access token's user id; it shares the login counter of that email. If the lookup fails, the limiter fails closed (`503`) like the other strict-auth limits | §4.9b |
| I-9 | The suspend `reason` is kept only in the `USER_SUSPENDED` audit log line (no column) | §4.13 |

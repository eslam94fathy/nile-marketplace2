# P8 security review (2026-10-13)

Scope: the whole API and worker on branch `p8-hardening` (P0–P7 code), against the OWASP API Security Top 10 (2023) and CLAUDE.md §10. Method: route and guard inventory, code reading per area, the existing integration tests, live probes against the local docker-compose stack, `npm audit`. Image and IaC scanning (Trivy) and the git-history secret scan (gitleaks) are plan step 3 and are reported there.

Severity: **High / Critical** must be fixed before staging (plan P8-Q14); **Medium** fixed in P8 unless accepted; **Low / Info** fixed when cheap, otherwise recorded.

## Summary

| # | Severity | Area (OWASP) | Finding | Status |
|---|---|---|---|---|
| F-1 | Medium | API10 Unsafe consumption | Kashier webhook: the signed field list comes from the payload and isn't required to cover the fields we act on | **Fixed** (spec 10 PA-21) |
| F-2 | Medium | API6 Business flows | A customer can hold stock with repeated unpaid Kashier checkouts | **Fixed** (spec 09 OR-16) |
| F-3 | Medium | API8 Misconfiguration | No startup guards for API docs in production, DB TLS and an https invite link in staging / production | **Fixed** |
| F-4 | Low | API2 Authentication | A suspended user's access token keeps working until it expires (≤ access-token TTL) | **Fixed** (spec 03 I-11, architecture v1.10) |
| F-5 | Low | API3 Property level | `__proto__` / `constructor` / `prototype` body keys are silently dropped instead of `400` | **Fixed** |
| F-6 | Low | API4 Resource consumption | The per-email rate-limit key isn't length-bounded | **Fixed** |
| F-7 | Low | Logging | The redaction list misses `signature` and `secretKey` style keys | **Fixed** |
| F-8 | – | API1 BOLA (tests) | Suspected missing cross-customer test on `POST /orders/:id/payment/kashier-session` | **Not a finding**: covered by `ordering-kashier.test.ts` (a stranger gets `404`) |
| F-9 | Info | API6 / idempotency | The idempotency lock TTL must exceed the longest request; COD remittances have no second duplicate guard | Recorded (runbook) |
| F-10 | Info | API2 | Registration answers `409 EMAIL_ALREADY_REGISTERED`, so it reveals registered emails | Accepted (strict per-IP and per-email limit; CLAUDE.md §10 covers login and forgot-password only) |

No High or Critical findings. `npm audit` (all and production dependencies): 0 vulnerabilities. Decisions on F-1, F-2 and F-4 by the user (2026-10-13); every fix has a regression test (see each finding).

## Findings

### F-1 Kashier webhook: signed fields not pinned (Medium)
`readKashierWebhook` (`src/pkg/payments/kashier-webhook.ts`) verifies the HMAC over the fields named in `data.signatureKeys`, which the request itself supplies, then acts on `merchantOrderId`, `status`, `amount`, `currency` and `transactionId`. Nothing requires those five to be among the signed keys. Nobody can forge a signature without `KASHIER_API_KEY`, but a validly signed body whose `signatureKeys` leaves out, say, `amount` would let that unsigned field be changed in transit or replayed with another value.
**Resolution:** a webhook whose `signatureKeys` miss any of the five is treated as an invalid signature (`401`, nothing stored); spec 10 PA-21. The dev signer and the tests already sign exactly these. To confirm against a real Kashier test webhook in P9 (P8-Q16). Test: `payment-gateways.test.ts` (one case per missing field).

### F-2 Stock held by unpaid Kashier checkouts (Medium)
A Kashier checkout reserves stock until `payment_expires_at` (15 min, spec 09 §3.1). The `checkout` limit is 10 per minute per user, so one customer can keep many units of a scarce variant reserved without paying, again and again; new accounts are limited only by the strict auth limit.
**Resolution:** at most one open `pending_payment` order per customer: another Kashier checkout answers `409 ORDER_PAYMENT_PENDING` (details: the open order's id) until it is paid, expires or fails; checked under the cart lock; COD unaffected (spec 09 OR-16). COD orders also hold stock until the seller accepts or the 24 h timeout, but the seller sees and can cancel them; accepted. Test: `ordering-kashier.test.ts`.

### F-3 Missing production guards in the env schema (Medium)
The schema already refuses `PAYMENT_GATEWAY=fake` and `EMAIL_PROVIDER=mailpit` in staging and production. It doesn't refuse `API_DOCS_ENABLED=true` in production (P0-Q4 says off), `DB_SSL=false` in staging or production (RDS enforces TLS, P8-Q9), or an `http://` `INVITE_URL_BASE` in staging or production (P1-Q6: https app link).
**Resolution:** the three guards are in the schema refinements (`DB_SSL` for every process with a database, the invite link for api and seed-admin, the docs for the api). No change for local development or tests. Test: `env.test.ts` (deployed-environment guards).

### F-4 Access tokens outlive a suspension (Low)
Suspending a user revokes every refresh token (spec 03 §2), but an access token already issued stays valid until it expires (`ACCESS_TOKEN_TTL`, 15 min): `authenticate` only verifies the JWT. Sellers and agents are also blocked by their business status on every write; a suspended **customer or admin** keeps their rights for up to 15 minutes. The spec doesn't say so.
**Resolution:** a Redis deny entry `auth:suspended:<userId>` (TTL = access-token lifetime) is written after a suspension commits (before the admin endpoint answers; after the caller's transaction for `setUserStatus`) and deleted on reactivation; `JwtVerifier` checks it after the signature and answers `401`; a failing check lets the request through with `warn SUSPENSION_CHECK_UNAVAILABLE` (spec 03 I-11, architecture v1.10). Tests: `jwt-verifier.test.ts`, `user-admin.service.test.ts`, `identity-admin-api.test.ts`, `delivery-agents.test.ts`.

### F-5 Prototype keys silently dropped (Low)
A body such as `{"__proto__": {...}, "email": ...}` is accepted: class-transformer drops the `__proto__` key, so it neither pollutes anything (checked) nor reaches validation, and the request goes through. CLAUDE.md §7 says unknown keys are rejected.
**Resolution:** `validateDto` rejects `__proto__`, `constructor` and `prototype` keys at any depth with `400 VALIDATION_FAILED` (constraint `forbiddenKey`), for bodies, queries and params alike. Test: `validate.test.ts`.

### F-6 Unbounded rate-limit key (Low)
`emailRateKey` lower-cases and trims the email from the body but doesn't bound it; a 100 KB string becomes a 100 KB Redis key for the window (still limited by the per-IP counter).
**Resolution:** the key is `email:<sha256 of the normalised email>`: fixed size, and no email in Redis. Test: `rate-limit-keys.test.ts`.

### F-7 Redaction list gaps (Low)
The logger redacts by exact key name. `signature`, `secretKey` / `kashierSecretKey` and `webhookSecret` aren't on the list. No code logs them today; the list is the safety net.
**Resolution:** added (`signature`, `secretKey`, `webhookSecret`, the Kashier and Mailjet key names). Test: `json-logger.test.ts`.

### F-8 Cross-customer test on the Kashier session endpoint (not a finding)
`CheckoutService.paymentPage` returns `404 ORDER_NOT_FOUND` for another customer's order. The first search missed the test: `ordering-kashier.test.ts` ("when Kashier fails at checkout…") already checks that a stranger gets `404`.

### F-9 Idempotency lock and long requests (Info)
The in-progress lock lives `IDEMPOTENCY_LOCK_TTL_SECONDS` (60 locally). If a request ran longer, a duplicate with the same key could execute. Checkout is still safe (the second one finds the cart locked, then empty), payouts are safe (unique external reference), shipment actions are state-machine guarded; a **COD remittance** has no second guard.
**Recommendation:** runbook rule: the lock TTL stays well above the longest request (statement timeout 10 s, provider timeouts 10 s); keep 60 s.

### F-10 Registration reveals registered emails (Info, accepted)
`POST /auth/register/*` answers `409 EMAIL_ALREADY_REGISTERED`. Login and forgot-password don't enumerate (dummy bcrypt, generic answers). Registration is under the strict limit (10 per 5 min per IP and per email). Accepted.

## Checked and found sound

- **Function-level authorization (API5):** every route is inventoried; every non-public route has `authenticate` + `requireRole`; public routes are the catalog reads, governorates, auth endpoints, health and the signature-checked webhook.
- **Object-level authorization (API1):** every owner-scoped read and write loads by the caller's id (addresses, cart lines, orders, seller orders and their actions through one `findForSeller`, products, variants, stock, agent shipments, finance self-service); each has a cross-user `404` test.
- **Authentication (API2):** RS256 pinned, `kid` key selection, `iss` / `aud` / `exp` / `iat` required; refresh tokens hashed, rotated, reuse revokes the family; suspension, password reset and change revoke sessions; login uses a dummy bcrypt hash for unknown accounts; OTPs from `crypto.randomInt`, hashed, attempt-limited.
- **Property level (API3):** one strict `validateDto` (whitelist, forbid unknown, no implicit conversion); response DTOs are explicit; no password hash in any DTO.
- **Resource consumption (API4):** body limit (413 checked), pagination maximum, `in` ≤ 50 values, text filters ≤ 100, search `q` bounded, strict limits on auth and checkout, general limit per IP; sensitive limits fail closed.
- **Injection:** raw SQL interpolates only table and column constants; values are bound; `like` filters escape wildcards; sort and filter columns come from whitelists.
- **Misconfiguration (API8):** helmet headers (CSP, HSTS, nosniff, frame options, referrer policy), no `x-powered-by`, CORS allow-list, `trust proxy` from env, malformed JSON → `400 MALFORMED_JSON` without a stack, generic `500` for unknown errors, correlation ids validated.
- **Unsafe consumption (API10):** webhook HMAC with a constant-time compare over the raw body, amount and currency checked, deduped per event, card data and signatures never stored (apart from F-1).
- **Secrets:** no `.env`, key or certificate file ever committed; dev-only scripts refuse to run outside `NODE_ENV=development`; test routes are never mounted by `server.ts`.

## Scanning (plan step 3, 2026-10-13)

| Scan | Tool | Result |
|---|---|---|
| Image: OS and npm packages, high / critical with a fix | Trivy 0.74.0 (`aquasec/trivy`) | **First run:** 7 HIGH in npm's own bundled packages (`brace-expansion`, `ip-address`, `tar`, `undici` under `/usr/local/lib/node_modules/npm`) and 3 CRITICAL + 4 HIGH in Debian `perl-base` (`deb12u3`, fixed in `deb12u4`), all from the `node:24.21.0-bookworm-slim` base image, none in our dependencies. **Fixed:** the runtime stage applies Debian security updates and removes npm, npx, corepack and yarn (the containers only run `node`). **Now clean.** Runs in CI on every PR |
| Configuration: Dockerfile (Terraform from step 4) | Trivy 0.74.0 `config` | Clean. Runs in CI on every PR (`node_modules` and `dist` skipped) |
| Secrets in the git history | gitleaks v8.30.1, all refs | 88 commits, **no leaks**. One-off (P8-Q14); repeat before a production go-live |
| Dependencies | `npm audit` | 0 vulnerabilities (already a CI step) |

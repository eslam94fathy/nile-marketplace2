# Spec 01 — API Conventions (shared by all module specs)

Status: **v1.0 APPROVED (2026-10-08).** Approved by the user. Changes from now on need explicit approval and a version bump.
Inputs: `CLAUDE.md` §7–§10, `docs/design/01-architecture.md` v1.0, `docs/design/02-database.md` v1.0.

Module specs: `03-identity.md` · `04-customers.md` · `05-sellers.md` · `06-catalog.md` · `07-inventory.md` · `08-cart.md` · `09-ordering.md` · `10-payments.md` · `11-delivery.md` · `12-finance.md` · `13-notifications.md`. Events: `02-events.md`.

---

## 1. How the module specs are written

Each module spec has the same sections:
1. **Scope & owned tables**
2. **Public API** (`index.ts`): the methods other modules may call, with the `trx` rule
3. **Use cases**: actor, preconditions, steps, effects, events
4. **Endpoints**: route, auth, guards, request DTOs, response DTO, success status, errors
5. **Events published / consumed** (names only; payloads are in `02-events.md`)
6. **Error codes**
7. **Open questions**

### 1.1 DTO notation
Request DTOs are tables. Every row becomes a class-validator decorator set. The `rules` column lists the decorators in shorthand:

| Shorthand | Meaning |
|---|---|
| `uuid` | `@IsUUID('7')` (path params and body ids). Other UUID versions → `400` |
| `str(a..b)` | `@IsString() @Length(a, b)`, after `trim` (`@Transform`) |
| `email` | `@IsEmail()`, `≤ 254`, trimmed and lower-cased before validation |
| `phone` | Egyptian mobile in E.164: `^\+20(10\|11\|12\|15)\d{8}$` |
| `money` | decimal string `^\d{1,10}(\.\d{1,2})?$` (fits `NUMERIC(12,2)`), parsed into `Money` in the service |
| `rate` | decimal string `^(0(\.\d{1,4})?\|1(\.0{1,4})?)$` (e.g. `"0.1000"` = 10%) |
| `int(a..b)` | `@IsInt() @Min(a) @Max(b)` on a JSON number (no string coercion, D2) |
| `bool` | `@IsBoolean()` on a JSON boolean |
| `enum(X)` | `@IsIn(Object.values(X))` |
| `opt` | `@IsOptional()`. `null` is **rejected** unless the row says `nullable` |
| `password` | `str(8..)` + custom `@MaxBytes(72)` (bcrypt limit, UTF-8 bytes). No composition rules (NIST 800-63B) |
| `otp` | `^\d{6}$` |
| `slug` | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, length as stated |

- Every request DTO is validated with `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues` (CLAUDE.md §7). Unknown keys → `400 VALIDATION_FAILED`.
- A PATCH DTO has every field `opt` plus a class-level `@AtLeastOneField()` validator: an empty body → `400 VALIDATION_FAILED`.
- Response DTOs are written as TypeScript shapes. Amounts are `string` (money). Timestamps are ISO-8601 UTC `string`s. Ids are UUID `string`s. Field names are camelCase.

### 1.2 Endpoint notation
```
METHOD /path            auth: <role | public | webhook>   rate: <general | strict-auth | checkout | none>   idem: <required | –>
```
All paths are under `/api/v1`.

## 2. Envelope

```jsonc
// success
{ "success": true, "data": { ... }, "meta": { "nextCursor": "…", "hasMore": true, "limit": 20 } }   // meta only on lists
// error
{ "success": false, "error": { "code": "PRODUCT_NOT_FOUND", "message": "…", "details": [ ... ] }, "correlationId": "…" }
```
- `204` responses have no body.
- `details` for `VALIDATION_FAILED`: `[{ "field": "variants[0].price", "constraint": "matches", "message": "…" }]`.
- `details` for domain errors that name entities (e.g. `INSUFFICIENT_STOCK`): `[{ "field": "variantId", "value": "<uuid>", "constraint": "<code>", "message": "…" }]`.

## 3. Authentication & authorization

- `Authorization: Bearer <access JWT>` (RS256, `kid` header). Claims: `sub` (user id), `role`, `iss`, `aud`, `iat`, `exp`. No profile ids and no PII in the token.
- Each module resolves the profile id (`customerId`, `sellerId`, `agentId`) from `sub` through its own unique index. If the profile is missing → `403 FORBIDDEN`.
- Role guard: `auth: customer` means "valid access token AND `role = customer`". A wrong role → `403 FORBIDDEN`.
- **Ownership failures return `404`**, not `403`, so a caller can't learn that another user's resource exists (e.g. a seller asking for another seller's order gets `404 SELLER_ORDER_NOT_FOUND`).
- Users with `status = suspended` can't log in or refresh. Their already issued access tokens expire on their own (short TTL).

## 4. Idempotency (CLAUDE.md §10, G25)

`idem: required` endpoints reject a request without `Idempotency-Key` with `400 IDEMPOTENCY_KEY_REQUIRED`.
- Key format: UUID (any version), validated.
- Scope: `user id + key`. Fingerprint: SHA-256 of `method + route template + canonical JSON body`.
- Concurrent duplicate → `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`. Completed duplicate → replay of the stored status code + body (header `Idempotent-Replayed: true`). Same key + different fingerprint → `422 IDEMPOTENCY_KEY_REUSED`.
- Only `2xx` and `4xx` responses are stored. A `5xx` releases the lock so the client can retry with the same key.
- Rule used in the module specs: **every POST with a money or stock effect requires a key.** Pure status transitions with no money/stock effect (e.g. seller "accept") don't, because the state machine already rejects a second call with `409`.

## 5. Lists (CLAUDE.md §8)

- `?limit=&cursor=&sort=` plus `field[op]=value` filters.
- Each list endpoint declares its **whitelist**: `apiField → column, type, ops`. Sort fields are declared in the same table (`sort: yes`). Every sort is tie-broken on `id`.
- `limit`: default and max come from env (proposed `20` / `100`).

## 6. Common error codes (`lib/error`)

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | DTO validation failed (`details` lists the fields) |
| `MALFORMED_JSON` | 400 | Body isn't valid JSON |
| `INVALID_CURSOR` | 400 | Cursor can't be decoded or doesn't match the sort |
| `INVALID_QUERY` | 400 | Unknown filter field/operator, bad filter value, unknown sort |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing/invalid `Idempotency-Key` on an `idem: required` route |
| `UNAUTHENTICATED` | 401 | Missing, malformed, expired or invalid access token |
| `FORBIDDEN` | 403 | Wrong role, or the profile behind the token is missing |
| `ROUTE_NOT_FOUND` | 404 | No route matches |
| `PAYLOAD_TOO_LARGE` | 413 | Body over the env limit |
| `CONFLICT` | 409 | Unmapped unique violation (`23505`) |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | Same key is still being processed |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different request |
| `REFERENCE_NOT_FOUND` | 422 | Unmapped FK violation (`23503`) |
| `CONSTRAINT_VIOLATION` | 422 | Unmapped check violation (`23514`) |
| `RATE_LIMITED` | 429 | Over the limit. `Retry-After` header set |
| `INTERNAL_ERROR` | 500 | Anything unexpected. Generic message |
| `SERVICE_UNAVAILABLE` | 503 | A fail-closed dependency (Redis on auth/checkout) is down |

Module error codes are **globally unique** and listed in each module spec. Repositories map known constraint names to module codes (e.g. `uq_users_email` → `EMAIL_ALREADY_REGISTERED`). Anything unmapped falls back to the generic codes above.

## 7. Rate-limit classes (values from env)

| Class | Key | Applies to |
|---|---|---|
| `strict-auth` | IP **and** normalised email (two counters) | register ×2, login, email verify, resend OTP, password forgot/reset, invite accept |
| `refresh` | IP | `POST /auth/refresh` |
| `checkout` | user id | `POST /checkout`, Kashier session |
| `general` | IP (+ user id when authenticated) | everything else |
| `none` | – | health, Kashier webhook (body-size limited instead) |

## 8. Shared enums (`lib/`)

- `UserRole`: `customer, seller, admin, delivery_agent`
- `ActorRole` (histories): `customer, seller, admin, delivery_agent, system`
- `PaymentMethod`: `cod, kashier`
- Money: the `Money` value object (EGP, `decimal.js`, `ROUND_HALF_UP`), serialised as a string with 2 decimals (`"150.00"`).

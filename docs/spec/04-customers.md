# Spec 04 — customers

Status: **v1.0 APPROVED (2026-10-09).** Approved by the user with the Phase 2 clarifications in §7.1. Changes from now on need explicit approval and a version bump.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Customer self-registration, profile, delivery addresses.
Tables: `customers`, `customer_addresses` (soft delete).
Depends on: `identity` (create the user, read the email).

Config: `CUSTOMER_MAX_ADDRESSES` (env, value 20, no default).

## 2. Public API (`index.ts`)

| Method | Used by | Notes |
|---|---|---|
| `getCustomerIdByUserId(userId) → string \| null` | cart, ordering | Resolves the profile from the JWT `sub` |
| `getAddressSnapshot(customerId, addressId, trx?) → AddressSnapshot` | ordering (checkout) | Throws `ADDRESS_NOT_FOUND` if it's missing, deleted, or another customer's |

`AddressSnapshot = { governorateId, recipientName, recipientPhone, city, area, street, building, floor, apartment, landmark }`.

## 3. Use cases

### UC-CU-1 Register as a customer
`identity.hashPassword` first (outside any transaction, C-1), then one transaction: `identity.createPendingUser(role = customer, passwordHash)` → insert `customers` → (identity has already written the OTP email to the outbox). Response: the account is `pending_email_verification`; no tokens until UC-ID-1.

### UC-CU-2 Manage addresses
- Every address write first locks the customer row (`SELECT … FROM customers WHERE id = ? FOR UPDATE`), so the limit check, the default rule and clearing the old default can't race (C-2).
- A new address becomes the default whatever `isDefault` says **whenever the customer has no live default** (the first address, or any address created after the default was deleted) (C-3).
- Setting `isDefault = true` clears the previous default in the same transaction (`uq_customer_addresses_customer_id_default` guarantees one).
- Deleting is soft. Deleting the default leaves the customer with no default (no automatic promotion). Checkout always sends an explicit `addressId`, so nothing depends on a default.
- Past orders aren't affected by edits or deletes (they keep a snapshot).
- The governorate must exist (FK → `422 GOVERNORATE_NOT_FOUND`). It may be non-deliverable; deliverability is checked at checkout (Q-26) and shown by `GET /governorates`.
- More than `CUSTOMER_MAX_ADDRESSES` live addresses → `ADDRESS_LIMIT_REACHED`.

## 4. Endpoints

### 4.1 `POST /auth/register/customer`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| email | `email` |
| password | `password` |
| firstName | `str(1..100)` |
| lastName | `str(1..100)` |
| phone | `phone` |

`201 { userId: string; email: string; status: 'pending_email_verification' }`.
Errors: `EMAIL_ALREADY_REGISTERED` 409.

### 4.2 Profile
```ts
interface CustomerProfileDto {
  id: string; email: string; firstName: string; lastName: string; phone: string; createdAt: string;
}
```
- `GET /me`   auth: customer → `200 CustomerProfileDto`.
- `PATCH /me`   auth: customer. Body (at least one): `firstName` `opt str(1..100)`, `lastName` `opt str(1..100)`, `phone` `opt phone`. → `200 CustomerProfileDto`.
  Email can't be changed in R1.

### 4.3 Addresses
```ts
interface AddressDto {
  id: string; label: string; recipientName: string; recipientPhone: string;
  governorateId: string; city: string; area: string; street: string; building: string;
  floor: string | null; apartment: string | null; landmark: string | null;
  isDefault: boolean; createdAt: string; updatedAt: string;
}
```
Create body (`CreateAddressDto`):

| field | rules |
|---|---|
| label | `str(1..50)` |
| recipientName | `str(1..100)` |
| recipientPhone | `phone` |
| governorateId | `uuid` |
| city | `str(1..100)` |
| area | `str(1..100)` |
| street | `str(1..200)` |
| building | `str(1..50)` |
| floor | `opt nullable str(1..10)` |
| apartment | `opt nullable str(1..10)` |
| landmark | `opt nullable str(1..200)` |
| isDefault | `bool` |

Update body (`UpdateAddressDto`): same fields, all `opt`, at least one. `isDefault: false` on the current default → `422 DEFAULT_ADDRESS_UNSET_NOT_ALLOWED` (set another address as default instead).

| Endpoint | auth | Success | Errors |
|---|---|---|---|
| `GET /me/addresses` | customer | `200 AddressDto[]` (no pagination, max 20; default first, then `-createdAt`) | – |
| `POST /me/addresses` | customer | `201 AddressDto` | `ADDRESS_LIMIT_REACHED` 422, `GOVERNORATE_NOT_FOUND` 422 |
| `GET /me/addresses/:addressId` | customer | `200 AddressDto` | `ADDRESS_NOT_FOUND` 404 |
| `PATCH /me/addresses/:addressId` | customer | `200 AddressDto` | `ADDRESS_NOT_FOUND` 404, `GOVERNORATE_NOT_FOUND` 422, `DEFAULT_ADDRESS_UNSET_NOT_ALLOWED` 422 |
| `DELETE /me/addresses/:addressId` | customer | `204` | `ADDRESS_NOT_FOUND` 404 |

## 5. Events
Published: none. Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `ADDRESS_NOT_FOUND` | 404 | Missing, deleted, or another customer's |
| `ADDRESS_LIMIT_REACHED` | 422 | Over `CUSTOMER_MAX_ADDRESSES` |
| `GOVERNORATE_NOT_FOUND` | 422 | FK `fk_customer_addresses_governorate_id` |
| `DEFAULT_ADDRESS_UNSET_NOT_ALLOWED` | 422 | Unsetting the default without choosing another |

(`EMAIL_ALREADY_REGISTERED` comes from identity. `GOVERNORATE_NOT_FOUND` is a common code, `01-api-conventions.md` §6 v1.2; this module maps its FK to it.)

## 7. Open questions
None specific to this module.

### 7.1 Clarifications (v1.0, Phase 2 plan, 2026-10-09)

| # | Clarification | Where |
|---|---|---|
| C-1 | The password is hashed before the registration transaction opens (spec 03 I-10, P2-Q2) | UC-CU-1 |
| C-2 | Address writes lock the customer row first (P2-Q6) | UC-CU-2 |
| C-3 | A new address becomes the default whenever the customer has no live default; deleting the default still promotes nothing (P2-Q6) | UC-CU-2 |
| C-4 | `GOVERNORATE_NOT_FOUND` is the common code from `lib/error` (P2-Q7) | §6 |

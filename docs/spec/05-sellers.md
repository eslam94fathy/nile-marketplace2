# Spec 05 — sellers

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED].
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Seller self-registration, profile + pickup address, approval lifecycle, per-seller commission, the default commission setting.
Tables: `sellers`, `seller_status_history`, `seller_commission_history`, `seller_settings`.
Depends on: `identity`.

Enum `SellerStatus`: `pending_approval, approved, rejected, suspended`.

State machine (overview §4.1):
```
pending_approval ─approve─► approved ─suspend─► suspended ─reinstate─► approved
pending_approval ─reject──► rejected ─reapply─► pending_approval
```
Every transition is a conditional update (`WHERE id = ? AND status = <expected>`) plus a `seller_status_history` row in the same transaction. 0 rows updated → `SELLER_INVALID_STATUS_TRANSITION`.

## 2. Public API (`index.ts`)

| Method | Used by | Notes |
|---|---|---|
| `getSellerByUserId(userId) → { sellerId, status } \| null` | catalog, ordering | Profile resolution + "is approved" guard |
| `getStatuses(sellerIds) → { sellerId, status }[]` | catalog (projection consumer) | Batched |
| `getSummaries(sellerIds) → { sellerId, businessName }[]` | catalog, cart, ordering | Display names, batched |
| `getCheckoutSnapshots(sellerIds, trx) → SellerCheckoutSnapshot[]` | ordering | `{ sellerId, status, businessName, commissionRate, pickup: { governorateId, phone, city, area, street, building, landmark } }` |

## 3. Use cases

### UC-SE-1 Register as a seller
One transaction: `identity.createPendingUser(role = seller)` → insert `sellers` with `status = pending_approval`, `commission_rate = seller_settings.default_commission_rate`, a history row (`from_status = null`). `uq_sellers_business_name_lower` → `BUSINESS_NAME_TAKEN`.

### UC-SE-2 Edit profile / re-apply
- The seller can edit the profile in any status. Edits affect **new** orders only (the pickup address is snapshotted per seller order).
- An approved seller does **not** need re-approval after an edit (S-7).
- A `rejected` seller edits and then calls **re-apply** → `pending_approval` (Q-29). `rejection_reason` is kept on the row until the next decision and stays in the history.

### UC-SE-3 Admin decisions
- **Approve** (`pending_approval → approved`): requires the user's email to be verified (`identity.getUsersByIds`) → otherwise `SELLER_EMAIL_NOT_VERIFIED`. Sets `approved_at` (first approval only), emits `seller.approved`.
- **Reject** (`pending_approval → rejected`): `reason` required (`chk_sellers_rejection_reason`).
- **Suspend** (`approved → suspended`): `reason` required. Emits `seller.suspended` → catalog hides the products. Open seller orders continue (Q-36). Login isn't blocked.
- **Reinstate** (`suspended → approved`): emits `seller.approved` (`previousStatus = suspended`).
- **Change commission:** a new rate on the seller row + a `seller_commission_history` row (old, new, admin). Only new checkouts use it (Q-6). Same rate as the current one → `COMMISSION_RATE_UNCHANGED`.
- **Default commission:** updates `seller_settings.default_commission_rate`. It applies to sellers who **register after** the change; existing sellers keep their own rate.

## 4. Endpoints

### 4.1 Shared DTOs
```ts
interface PickupAddressDto {
  governorateId: string; city: string; area: string; street: string; building: string; landmark: string | null;
}
interface SellerProfileDto {
  id: string; email: string; businessName: string; contactPhone: string;
  pickupAddress: PickupAddressDto;
  status: SellerStatus; rejectionReason: string | null;
  commissionRate: string; approvedAt: string | null; createdAt: string; updatedAt: string;
}
```
`PickupAddressInput` (nested, `@ValidateNested @Type`):

| field | rules |
|---|---|
| governorateId | `uuid` |
| city | `str(1..100)` |
| area | `str(1..100)` |
| street | `str(1..200)` |
| building | `str(1..50)` |
| landmark | `opt nullable str(1..200)` |

### 4.2 `POST /auth/register/seller`   auth: public · rate: strict-auth
| field | rules |
|---|---|
| email | `email` |
| password | `password` |
| businessName | `str(2..150)` |
| contactPhone | `phone` |
| pickupAddress | `PickupAddressInput` |

`201 { userId: string; sellerId: string; email: string; status: 'pending_email_verification'; sellerStatus: 'pending_approval' }`.
Errors: `EMAIL_ALREADY_REGISTERED` 409, `BUSINESS_NAME_TAKEN` 409, `GOVERNORATE_NOT_FOUND` 422.

### 4.3 Seller self-service   auth: seller · rate: general
| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /seller/profile` | – | `200 SellerProfileDto` | – |
| `PATCH /seller/profile` | `businessName opt str(2..150)`, `contactPhone opt phone`, `pickupAddress opt PickupAddressInput` (replaced as a whole); at least one | `200 SellerProfileDto` | `BUSINESS_NAME_TAKEN` 409, `GOVERNORATE_NOT_FOUND` 422 |
| `POST /seller/profile/reapply` | – | `200 SellerProfileDto` | `SELLER_INVALID_STATUS_TRANSITION` 409 (not `rejected`) |

### 4.4 Admin   auth: admin · rate: general
```ts
interface AdminSellerListItemDto {
  id: string; businessName: string; email: string; contactPhone: string; status: SellerStatus;
  commissionRate: string; pickupGovernorateId: string; createdAt: string; approvedAt: string | null;
}
interface AdminSellerDetailDto extends AdminSellerListItemDto {
  pickupAddress: PickupAddressDto; rejectionReason: string | null; emailVerified: boolean;
  statusHistory: { fromStatus: SellerStatus | null; toStatus: SellerStatus; reason: string | null;
                   actorUserId: string | null; createdAt: string }[];          // newest first, last 50
  commissionHistory: { oldRate: string; newRate: string; changedByUserId: string; createdAt: string }[]; // last 50
}
```

`GET /admin/sellers`. Whitelist:

| apiField | column | type | ops | sort |
|---|---|---|---|---|
| status | `status` | enum | `eq, in` | – |
| createdAt | `created_at` | date | `gte, lte` | yes (default `-createdAt`) |
| businessName | `business_name` | text | `like` | – |
| pickupGovernorateId | `pickup_governorate_id` | uuid | `eq` | – |

`200 AdminSellerListItemDto[]` + meta. The emails come from one batched `identity.getUsersByIds` call.

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `GET /admin/sellers/:sellerId` | – | `200 AdminSellerDetailDto` | `SELLER_NOT_FOUND` 404 |
| `POST /admin/sellers/:sellerId/approve` | – | `200 AdminSellerDetailDto` | `SELLER_NOT_FOUND` 404, `SELLER_INVALID_STATUS_TRANSITION` 409, `SELLER_EMAIL_NOT_VERIFIED` 409 |
| `POST /admin/sellers/:sellerId/reject` | `reason str(3..500)` | `200` | `SELLER_NOT_FOUND`, `SELLER_INVALID_STATUS_TRANSITION` |
| `POST /admin/sellers/:sellerId/suspend` | `reason str(3..500)` | `200` | same |
| `POST /admin/sellers/:sellerId/reinstate` | `reason opt str(3..500)` | `200` | same |
| `PUT /admin/sellers/:sellerId/commission-rate` | `commissionRate rate` | `200` | `SELLER_NOT_FOUND`, `COMMISSION_RATE_UNCHANGED` 409 |
| `GET /admin/settings/commission` | – | `200 { defaultCommissionRate: string; updatedAt: string }` | – |
| `PUT /admin/settings/commission` | `defaultCommissionRate rate` | `200` same shape | – |

## 5. Events
Published: `seller.approved` (approve, reinstate), `seller.suspended`.
Consumed: none.

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `SELLER_NOT_FOUND` | 404 | |
| `SELLER_INVALID_STATUS_TRANSITION` | 409 | Transition not allowed from the current status |
| `SELLER_EMAIL_NOT_VERIFIED` | 409 | Approve before email verification (Q-40) |
| `SELLER_NOT_APPROVED` | 403 | Thrown by other modules' guards (catalog writes) when the seller isn't `approved` |
| `BUSINESS_NAME_TAKEN` | 409 | `uq_sellers_business_name_lower` |
| `COMMISSION_RATE_UNCHANGED` | 409 | New rate equals the current one |

## 7. Open questions
- **S-7** Re-approval after an approved seller edits the profile: see `00-overview.md` §8.

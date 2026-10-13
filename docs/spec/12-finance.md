# Spec 12 — finance

Status: **v1.0 APPROVED (2026-10-13)**, with the Phase 7 clarifications in §7.1. Changes from now on need explicit approval and a version bump.
Conventions: `01-api-conventions.md`. Events: `02-events.md`.

## 1. Scope & owned tables

Account balances + an immutable ledger (database §11): seller earnings, platform commission and delivery revenue, agent fee shares, COD cash held by agents, admin-confirmed COD remittances, and payouts recorded by admins (paid outside the system, Q-11, Q-38).
Tables: `finance_accounts`, `ledger_entries`, `cod_remittances`, `payouts`.
Depends on: `sellers` and `delivery` (profile resolution for `/seller/finance` and `/agent/finance`, and display names). Neither of them calls finance, so the graph stays acyclic (A-2).

### 1.1 Accounts and sign convention
`balance = Σ credits − Σ debits`. Every entry updates its account's `balance` in the same transaction, with the account row locked (`FOR UPDATE`), and stores `balance_after`.

| `account_type` | owner | Meaning of a positive balance | May go negative? |
|---|---|---|---|
| `seller_payable` | seller | Platform owes the seller | No |
| `agent_fee_payable` | agent | Platform owes the agent (fee shares) | No |
| `agent_cod_cash` | agent | The agent holds platform cash | No |
| `platform_commission_revenue` | – | Commission earned | No |
| `platform_delivery_revenue` | – | Delivery fees kept by the platform | **Yes**: briefly when events arrive out of order (see 1.2), and for good by the agent shares of a COD checkout whose fee was never collected (S-3, FI-1) |

The non-negative rule is also a DB CHECK (`chk_finance_accounts_balance_non_negative`, database §11).

Accounts are created lazily. To avoid deadlocks, accounts touched by one booking are locked **sorted by account id** (FI-3): one multi-row `INSERT … ON CONFLICT (account_type, owner_id) DO NOTHING` for every account the booking touches, then one `SELECT … WHERE (account_type, owner_id) IN (…) ORDER BY id FOR UPDATE`, then the entries (one multi-row insert) and one balance update per account. Finance locks only its own rows and calls no other module inside the transaction.

### 1.2 Booking rules (consumer `finance.ledger`)
One transaction per event, with the `processed_events` row and `source_event_id` on every entry; a replay is a no-op (dedupe). An entry is written only for an amount `> 0`. Amounts are taken from the payload as they are (ordering computed and rounded them, spec 09 §3.8) and parsed through `Money`; a payload that doesn't parse is a permanent failure (DLQ) (FI-4).

`seller_order.delivered` (`reference_type = 'seller_order'`):
| # | Account | Dir | Amount | `entry_type` | When |
|---|---|---|---|---|---|
| 1 | `seller_payable(sellerId)` | credit | `sellerNet` | `seller_net_earned` | `> 0` |
| 2 | `platform_commission_revenue` | credit | `commission` | `commission_earned` | `> 0` |
| 3 | `agent_fee_payable(agentId)` | credit | `agentFeeShare` | `agent_fee_earned` | `> 0` |
| 4 | `platform_delivery_revenue` | debit | `agentFeeShare` | `agent_fee_earned` | `> 0` |
| 5 | `agent_cod_cash(agentId)` | credit | `codCollectedAmount` | `cod_cash_collected` | COD |
| 6 | `platform_delivery_revenue` | credit | `deliveryFeeAmount` | `platform_fee_earned` | COD, `deliveryFeeCollected` |

`order.closed` (`reference_type = 'order'`):
| # | Account | Dir | Amount | `entry_type` | When |
|---|---|---|---|---|---|
| 7 | `platform_delivery_revenue` | credit | `deliveryFee` | `platform_fee_earned` | Kashier, `deliveryFee > 0` |

Any other `order.closed` (COD, or a fee of `0.00`) is acked with nothing written: a COD fee is booked when collected (row 6).

Why it balances: for each checkout, platform delivery revenue = fee actually charged − Σ agent shares (= the 30% plus the shares of undelivered shipments, Q-37). Rows 4/6/7 can arrive in any order, which is why `platform_delivery_revenue` may dip below 0 for a moment. If a COD fee is never collected (S-3), the delivered seller orders' agent shares still count, and the checkout leaves delivery revenue below 0: that is the platform's real loss, matching the `COD_DELIVERY_FEE_UNCOLLECTED` log line (FI-1).

Example (overview §5): COD, fee 60, 3 seller orders, 1 cancelled, 2 delivered (the first carried the fee) → agents +14 +14, delivery revenue +60 −14 −14 = 32. ✓

### 1.3 Admin actions
- **COD remittance** (Q-18): debit `agent_cod_cash(agentId)` (`cod_cash_remitted`, `reference_type = 'cod_remittance'`), insert `cod_remittances`. Before the transaction, `delivery.getAgentSummaries([agentId])`: unknown → `AGENT_NOT_FOUND`. No account, or `amount > balance` → `REMITTANCE_EXCEEDS_BALANCE`. The FK stays as the backstop (same code). Agents of any status can remit (FI-5).
- **Payout** (Q-11, Q-38): debit `seller_payable` or `agent_fee_payable` (`seller_payout` / `agent_payout`, `reference_type = 'payout'`), insert `payouts`. Before the transaction, the payee is resolved (`sellers.getSummaries` / `delivery.getAgentSummaries`): unknown → `PAYEE_NOT_FOUND`. No account, or `amount > balance` → `PAYOUT_EXCEEDS_BALANCE`. Sellers and agents of any status can be paid (FI-6). The same `externalReference` for the same payee → `PAYOUT_ALREADY_RECORDED` (`uq_payouts_payee_type_payee_id_external_reference`, FI-7). `paidAt` must be `<= now` (the `Clock`, no tolerance) → else `PAID_AT_IN_FUTURE` (FI-9).
- Both: one transaction, account `FOR UPDATE`, outbox event, `Idempotency-Key` required.

## 2. Public API (`index.ts`)
None in R1 (nobody calls finance synchronously).

## 3. Use cases
Covered by §1.2 (event-driven bookings) and §1.3 (admin actions), plus the read endpoints below.

## 4. Endpoints

```ts
interface AccountDto {
  id: string; accountType: string; ownerId: string | null;
  ownerName: string | null;            // seller business name / agent full name (batched lookups, FI-11)
  balance: string; updatedAt: string;
}
interface LedgerEntryDto {
  id: string; direction: 'credit' | 'debit'; amount: string; balanceAfter: string; entryType: string;
  referenceType: string; referenceId: string; createdAt: string;
}
interface RemittanceDto { id: string; agentId: string; amount: string; confirmedByUserId: string; note: string | null; createdAt: string }
interface PayoutDto {
  id: string; payeeType: 'seller' | 'agent'; payeeId: string; amount: string; externalReference: string;
  recordedByUserId: string; paidAt: string; createdAt: string;
}
```

### 4.1 Admin   auth: admin · rate: general
| Endpoint | idem | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /admin/finance/accounts` | – | whitelist `accountType` (`eq,in`), `ownerId` (`eq`), `balance` (money, `gt,gte`, sort), `updatedAt` (sort, default `-balance`) | `200 AccountDto[]` + meta | – |
| `GET /admin/finance/accounts/:accountId` | – | – | `200 AccountDto` | `ACCOUNT_NOT_FOUND` 404 |
| `GET /admin/finance/accounts/:accountId/entries` | – | whitelist `entryType` (`eq,in`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 LedgerEntryDto[]` + meta | `ACCOUNT_NOT_FOUND` |
| `GET /admin/finance/entries` | – | `referenceType` (`eq`, `enum(seller_order, order, cod_remittance, payout)`) + `referenceId` (`eq`), both required. Not paginated: one reference has at most 6 entries (FI-9) | `200 LedgerEntryDto[]` (+ `accountId`) | `INVALID_QUERY` 400 |
| `POST /admin/finance/cod-remittances` | required | `agentId uuid` · `amount money` (> 0) · `note opt str(1..500)` | `201 RemittanceDto` | `AGENT_NOT_FOUND` 422, `REMITTANCE_EXCEEDS_BALANCE` 422 |
| `GET /admin/finance/cod-remittances` | – | whitelist `agentId` (`eq`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 RemittanceDto[]` + meta | – |
| `POST /admin/finance/payouts` | required | `payeeType enum(seller, agent)` · `payeeId uuid` · `amount money` (> 0) · `externalReference str(1..200)` · `paidAt` ISO date-time, not in the future | `201 PayoutDto` | `PAYEE_NOT_FOUND` 422, `PAYOUT_EXCEEDS_BALANCE` 422, `PAID_AT_IN_FUTURE` 422, `PAYOUT_ALREADY_RECORDED` 409 |
| `GET /admin/finance/payouts` | – | whitelist `payeeType` (`eq`), `payeeId` (`eq`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 PayoutDto[]` + meta | – |

Seller and agent endpoints (§4.2, §4.3) serve a profile in **any** status: they are read-only views of the caller's own money, which a suspended seller or an inactive agent still needs. No profile → `500` (P4-Q9 rule). They only ever filter by the caller's own account or id; there is no id in the path (FI-8, FI-11).

### 4.2 Seller   auth: seller (S-14)
| Endpoint | Success |
|---|---|
| `GET /seller/finance/balance` | `200 { balance: string; updatedAt: string \| null }` (`"0.00"` and `null` when no account yet) |
| `GET /seller/finance/entries` | `200 LedgerEntryDto[]` + meta (whitelist as admin entries) |
| `GET /seller/finance/payouts` | `200 PayoutDto[]` + meta (own only) |

### 4.3 Agent   auth: delivery_agent (S-14)
| Endpoint | Success |
|---|---|
| `GET /agent/finance/balances` | `200 { feePayable: string; codCashHeld: string }` (`"0.00"` for a missing account) |
| `GET /agent/finance/entries?account=fee\|cod` | `200 LedgerEntryDto[]` + meta. `account` required, `enum(fee, cod)` |
| `GET /agent/finance/remittances` | `200 RemittanceDto[]` + meta (own only) |

## 5. Events
Published: `cod.remittance_confirmed`, `payout.recorded`.
Consumed: `seller_order.delivered`, `order.closed` (`finance.ledger`).

## 6. Error codes

| Code | HTTP | When |
|---|---|---|
| `ACCOUNT_NOT_FOUND` | 404 | |
| `REMITTANCE_EXCEEDS_BALANCE` | 422 | Remittance > the agent's COD cash |
| `PAYOUT_EXCEEDS_BALANCE` | 422 | Payout > the payable balance, or the payee has no account yet |
| `PAYEE_NOT_FOUND` | 422 | Payout to a seller / agent id that doesn't exist (FI-6) |
| `PAYOUT_ALREADY_RECORDED` | 409 | Same `externalReference` already recorded for this payee (FI-7) |
| `PAID_AT_IN_FUTURE` | 422 | |
| `AGENT_NOT_FOUND` | 422 | Remittance for an unknown agent (lookup first, FK `fk_cod_remittances_agent_id` as the backstop, FI-5) |

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-14** Seller / agent read-only finance endpoints are in R1.

### 7.1 Clarifications (v1.0, Phase 7 plan, 2026-10-13)

| # | Clarification | Where |
|---|---|---|
| FI-1 | `platform_delivery_revenue` may go negative briefly (events out of order) and for good by the agent shares of a COD checkout whose fee was never collected (S-3); the agents keep their share (P7-Q2) | §1.1, §1.2 |
| FI-2 | Schema: database v1.12 (D-12): finance cursor timestamps `TIMESTAMPTZ(3)`, the non-negative balance CHECK, enum CHECKs incl. `reference_type`, list indexes, FKs `RESTRICT`, polymorphic owner / payee ids without FK (P7-Q3) | §1 |
| FI-3 | One booking: insert missing accounts in one statement, lock them in one `ORDER BY id FOR UPDATE`, then entries and balances. Finance locks only its own rows; the platform accounts are a hot row, accepted at the scale targets (P7-Q4) | §1.1 |
| FI-4 | Entries only for amounts `> 0`; replays are no-ops; `order.closed` books only row 7 (Kashier, fee `> 0`), others are acked; payload amounts used as they are, an unparseable payload goes to the DLQ (P7-Q5) | §1.2 |
| FI-5 | Remittance: unknown agent → `AGENT_NOT_FOUND` (looked up first); no account or over the balance → `REMITTANCE_EXCEEDS_BALANCE`; any agent status (P7-Q6) | §1.3 |
| FI-6 | Payout: unknown payee → `PAYEE_NOT_FOUND`; known without an account → `PAYOUT_EXCEEDS_BALANCE`; any seller / agent status (P7-Q7) | §1.3 |
| FI-7 | `uq_payouts_payee_type_payee_id_external_reference` → `409 PAYOUT_ALREADY_RECORDED`; remittances stay unconstrained (P7-Q8) | §1.3 |
| FI-8 | `/seller/finance/*` and `/agent/finance/*` serve any profile status; no profile → `500` (P7-Q9) | §4 |
| FI-9 | `paidAt <= now` (the `Clock`, no tolerance); the reference lookup isn't paginated and `referenceType` is an enum of the four reference types (P7-Q10) | §1.3, §4.1 |
| FI-10 | Process split: api serves every finance endpoint; the worker runs only `finance.ledger` (it resolves no names). No env keys (P7-Q11) | §3 |
| FI-11 | `ownerName` from one batched `sellers.getSummaries` + one `delivery.getAgentSummaries` per page; `null` for platform accounts and for an owner the lookup no longer returns (`warn`). Missing accounts read as `"0.00"` on the seller / agent balance endpoints (P7-Q12) | §4 |

# Spec 12 — finance

Status: **DRAFT v0.1 (2026-10-08), under review.** [PROPOSED] unless it restates overview §5 / §1 "Money flow & payouts".
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
| `platform_delivery_revenue` | – | Delivery fees kept by the platform | **Yes, briefly** (see 1.2) |

Accounts are created lazily (`INSERT … ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`). To avoid deadlocks, accounts touched by one booking are locked **sorted by account id**.

### 1.2 Booking rules (consumer `finance.ledger`)
One transaction per event, with the `processed_events` row and `source_event_id` on every entry.

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

Why it balances: for each checkout, platform delivery revenue = fee actually charged − Σ agent shares (= the 30% plus the shares of undelivered shipments, Q-37). Rows 4/6/7 can arrive in any order, which is why `platform_delivery_revenue` may dip below 0 for a moment.

Example (overview §5): COD, fee 60, 3 seller orders, 1 cancelled, 2 delivered (the first carried the fee) → agents +14 +14, delivery revenue +60 −14 −14 = 32. ✓

### 1.3 Admin actions
- **COD remittance** (Q-18): debit `agent_cod_cash(agentId)` (`cod_cash_remitted`), insert `cod_remittances`. `amount > balance` → `REMITTANCE_EXCEEDS_BALANCE`.
- **Payout** (Q-11, Q-38): debit `seller_payable` or `agent_fee_payable` (`seller_payout` / `agent_payout`), insert `payouts`. `amount > balance` (or no account) → `PAYOUT_EXCEEDS_BALANCE`.
- Both: one transaction, account `FOR UPDATE`, outbox event, `Idempotency-Key` required.

## 2. Public API (`index.ts`)
None in R1 (nobody calls finance synchronously).

## 3. Use cases
Covered by §1.2 (event-driven bookings) and §1.3 (admin actions), plus the read endpoints below.

## 4. Endpoints

```ts
interface AccountDto {
  id: string; accountType: string; ownerId: string | null;
  ownerName: string | null;            // seller business name / agent full name (batched lookups)
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
| `GET /admin/finance/entries` | – | `referenceType` (`eq`) + `referenceId` (`eq`), both required | `200 LedgerEntryDto[]` (+ `accountId`) | `INVALID_QUERY` 400 |
| `POST /admin/finance/cod-remittances` | required | `agentId uuid` · `amount money` (> 0) · `note opt str(1..500)` | `201 RemittanceDto` | `AGENT_NOT_FOUND` 422, `REMITTANCE_EXCEEDS_BALANCE` 422 |
| `GET /admin/finance/cod-remittances` | – | whitelist `agentId` (`eq`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 RemittanceDto[]` + meta | – |
| `POST /admin/finance/payouts` | required | `payeeType enum(seller, agent)` · `payeeId uuid` · `amount money` (> 0) · `externalReference str(1..200)` · `paidAt` ISO date-time, not in the future | `201 PayoutDto` | `PAYOUT_EXCEEDS_BALANCE` 422, `PAID_AT_IN_FUTURE` 422 |
| `GET /admin/finance/payouts` | – | whitelist `payeeType` (`eq`), `payeeId` (`eq`), `createdAt` (`gte,lte`, sort, default `-createdAt`) | `200 PayoutDto[]` + meta | – |

### 4.2 Seller   auth: seller (S-14)
| Endpoint | Success |
|---|---|
| `GET /seller/finance/balance` | `200 { balance: string; updatedAt: string \| null }` (`"0.00"` when no account yet) |
| `GET /seller/finance/entries` | `200 LedgerEntryDto[]` + meta (whitelist as admin entries) |
| `GET /seller/finance/payouts` | `200 PayoutDto[]` + meta (own only) |

### 4.3 Agent   auth: delivery_agent (S-14)
| Endpoint | Success |
|---|---|
| `GET /agent/finance/balances` | `200 { feePayable: string; codCashHeld: string }` |
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
| `PAYOUT_EXCEEDS_BALANCE` | 422 | Payout > the payable balance, or no account |
| `PAID_AT_IN_FUTURE` | 422 | |
| `AGENT_NOT_FOUND` | 422 | FK `fk_cod_remittances_agent_id` |

## 7. Decisions (answered 2026-10-08, `00-overview.md` §9.1). No open questions.
- **S-14** Seller / agent read-only finance endpoints are in R1.

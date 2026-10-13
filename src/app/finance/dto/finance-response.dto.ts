import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { IsMoney } from '../../../lib/http';
import { AccountType, EntryDirection, EntryType, PayeeType, ReferenceType } from '../enums';
import { type LedgerEntry } from '../model/ledger.model';
import { type CodRemittance, type Payout } from '../model/settlement.model';
import { type AccountView } from '../service/finance-view.service';

/* Spec 12 §4 response DTOs: they describe the OpenAPI shape. Balances may be negative (FI-1). */

/** A signed amount with 2 decimals (`platform_delivery_revenue` may go below 0). */
const SIGNED_MONEY = /^-?\d{1,12}\.\d{2}$/;

export class AccountDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(AccountType))
  accountType!: AccountType;

  @IsOptional()
  @IsUUID()
  ownerId!: string | null;

  /** Seller business name / agent full name; null for platform accounts. */
  @IsOptional()
  @IsString()
  ownerName!: string | null;

  @Matches(SIGNED_MONEY)
  balance!: string;

  @IsDateString()
  updatedAt!: string;
}

export class LedgerEntryDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(EntryDirection))
  direction!: EntryDirection;

  @IsMoney()
  amount!: string;

  @Matches(SIGNED_MONEY)
  balanceAfter!: string;

  @IsIn(Object.values(EntryType))
  entryType!: EntryType;

  @IsIn(Object.values(ReferenceType))
  referenceType!: ReferenceType;

  @IsUUID()
  referenceId!: string;

  @IsDateString()
  createdAt!: string;
}

/** `GET /admin/finance/entries`: entries of several accounts, so each names its account. */
export class ReferenceEntryDto extends LedgerEntryDto {
  @IsUUID()
  accountId!: string;
}

export class RemittanceDto {
  @IsUUID()
  id!: string;

  @IsUUID()
  agentId!: string;

  @IsMoney()
  amount!: string;

  @IsUUID()
  confirmedByUserId!: string;

  @IsOptional()
  @IsString()
  note!: string | null;

  @IsDateString()
  createdAt!: string;
}

export class PayoutDto {
  @IsUUID()
  id!: string;

  @IsIn(Object.values(PayeeType))
  payeeType!: PayeeType;

  @IsUUID()
  payeeId!: string;

  @IsMoney()
  amount!: string;

  @IsString()
  externalReference!: string;

  @IsUUID()
  recordedByUserId!: string;

  @IsDateString()
  paidAt!: string;

  @IsDateString()
  createdAt!: string;
}

export function toAccountDto(view: AccountView): AccountDto {
  const { account } = view;
  return {
    id: account.id,
    accountType: account.accountType,
    ownerId: account.ownerId,
    ownerName: view.ownerName,
    balance: account.balance.toString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

export function toLedgerEntryDto(entry: LedgerEntry): LedgerEntryDto {
  return {
    id: entry.id,
    direction: entry.direction,
    amount: entry.amount.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    entryType: entry.entryType,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt.toISOString(),
  };
}

export const toReferenceEntryDto = (entry: LedgerEntry): ReferenceEntryDto => ({
  ...toLedgerEntryDto(entry),
  accountId: entry.accountId,
});

export function toRemittanceDto(remittance: CodRemittance): RemittanceDto {
  return {
    id: remittance.id,
    agentId: remittance.agentId,
    amount: remittance.amount.toString(),
    confirmedByUserId: remittance.confirmedByUserId,
    note: remittance.note,
    createdAt: remittance.createdAt.toISOString(),
  };
}

export function toPayoutDto(payout: Payout): PayoutDto {
  return {
    id: payout.id,
    payeeType: payout.payeeType,
    payeeId: payout.payeeId,
    amount: payout.amount.toString(),
    externalReference: payout.externalReference,
    recordedByUserId: payout.recordedByUserId,
    paidAt: payout.paidAt.toISOString(),
    createdAt: payout.createdAt.toISOString(),
  };
}

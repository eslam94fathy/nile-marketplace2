import { IsIn, IsISO8601, Matches } from 'class-validator';
import {
  FieldType,
  FilterOp,
  IsPositiveMoney,
  type ListSpec,
  Optional,
  StrField,
  UuidField,
} from '../../../lib/http';
import { EXTERNAL_REFERENCE_MAX_LENGTH, REMITTANCE_NOTE_MAX_LENGTH } from '../constants';
import { AccountType, EntryType, PayeeType, ReferenceType } from '../enums';

/* Spec 12 §4.1 request DTOs and list whitelists. */

/** A date-time with a time and an explicit offset, so a payout date is never read in local time. */
const DATE_TIME_WITH_OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export class AccountIdParamsDto {
  @UuidField()
  accountId!: string;
}

/** `POST /admin/finance/cod-remittances` (spec 12 §1.3). */
export class CreateRemittanceDto {
  @UuidField()
  agentId!: string;

  @IsPositiveMoney()
  amount!: string;

  @Optional()
  @StrField(1, REMITTANCE_NOTE_MAX_LENGTH)
  note?: string;
}

/** `POST /admin/finance/payouts` (spec 12 §1.3). */
export class CreatePayoutDto {
  @IsIn(Object.values(PayeeType))
  payeeType!: PayeeType;

  @UuidField()
  payeeId!: string;

  @IsPositiveMoney()
  amount!: string;

  /** The bank / wallet transfer reference. */
  @StrField(1, EXTERNAL_REFERENCE_MAX_LENGTH)
  externalReference!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(DATE_TIME_WITH_OFFSET, { message: 'paidAt must be a date-time with a time zone offset' })
  paidAt!: string;
}

const createdAtSort = {
  column: 'created_at',
  type: FieldType.DATE,
  ops: [FilterOp.GTE, FilterOp.LTE],
  sortable: true,
} as const;

/** `GET /admin/finance/accounts` (default `-balance`). */
export const ACCOUNT_LIST_SPEC: ListSpec = {
  fields: {
    accountType: {
      column: 'account_type',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(AccountType),
    },
    ownerId: { column: 'owner_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    balance: { column: 'balance', type: FieldType.MONEY, ops: [FilterOp.GT, FilterOp.GTE], sortable: true },
    updatedAt: { column: 'updated_at', type: FieldType.DATE, ops: [], sortable: true },
  },
  defaultSort: '-balance',
};

/** Statements (admin, seller, agent): newest first by default. */
export const ENTRY_LIST_SPEC: ListSpec = {
  fields: {
    entryType: {
      column: 'entry_type',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ, FilterOp.IN],
      enumValues: Object.values(EntryType),
    },
    createdAt: createdAtSort,
  },
  defaultSort: '-createdAt',
};

/** `GET /admin/finance/entries`: both filters required, not paginated (FI-9). */
export const ENTRIES_BY_REFERENCE_SPEC: ListSpec = {
  fields: {
    referenceType: {
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(ReferenceType),
    },
    referenceId: { type: FieldType.UUID, ops: [FilterOp.EQ] },
    createdAt: { column: 'created_at', type: FieldType.DATE, ops: [], sortable: true },
  },
  defaultSort: 'createdAt',
};

/** `GET /admin/finance/cod-remittances`. */
export const REMITTANCE_LIST_SPEC: ListSpec = {
  fields: {
    agentId: { column: 'agent_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    createdAt: createdAtSort,
  },
  defaultSort: '-createdAt',
};

/** `GET /admin/finance/payouts`. */
export const PAYOUT_LIST_SPEC: ListSpec = {
  fields: {
    payeeType: {
      column: 'payee_type',
      type: FieldType.ENUM,
      ops: [FilterOp.EQ],
      enumValues: Object.values(PayeeType),
    },
    payeeId: { column: 'payee_id', type: FieldType.UUID, ops: [FilterOp.EQ] },
    createdAt: createdAtSort,
  },
  defaultSort: '-createdAt',
};

/** The seller's / agent's own payouts and remittances: always scoped to the caller (FI-11). */
export const OWN_SETTLEMENT_LIST_SPEC: ListSpec = {
  fields: { createdAt: createdAtSort },
  defaultSort: '-createdAt',
};

/** `GET /seller/finance/holds` (spec 12 §8.6): unreleased holds, oldest first. */
export const HOLD_LIST_SPEC: ListSpec = {
  fields: { releaseAfter: { column: 'release_after', type: FieldType.DATE, ops: [], sortable: true } },
  defaultSort: 'releaseAfter',
};

/** `GET /agent/finance/entries?account=fee|cod` (spec 12 §4.3). */
export const AgentStatementAccount = {
  FEE: 'fee',
  COD: 'cod',
} as const;
export type AgentStatementAccount = (typeof AgentStatementAccount)[keyof typeof AgentStatementAccount];

/** The agent's statement: the admin whitelist plus the required `account` parameter. */
export const AGENT_ENTRY_LIST_SPEC: ListSpec = { ...ENTRY_LIST_SPEC, extraParams: ['account'] };

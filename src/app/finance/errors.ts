import { AppError, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** finance error codes (docs/spec/12-finance.md §6). */
export const FinanceErrorCode = {
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  REMITTANCE_EXCEEDS_BALANCE: 'REMITTANCE_EXCEEDS_BALANCE',
  PAYOUT_EXCEEDS_BALANCE: 'PAYOUT_EXCEEDS_BALANCE',
  PAYEE_NOT_FOUND: 'PAYEE_NOT_FOUND',
  PAYOUT_ALREADY_RECORDED: 'PAYOUT_ALREADY_RECORDED',
  PAID_AT_IN_FUTURE: 'PAID_AT_IN_FUTURE',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
} as const;

const C = FinanceErrorCode;
const S = HTTP_STATUS;

export const accountNotFound = () =>
  new AppError(C.ACCOUNT_NOT_FOUND, 'Finance account not found', S.NOT_FOUND);

/** No COD cash account yet counts as a balance of 0 (spec 12 FI-5). */
export const remittanceExceedsBalance = (balance: string) =>
  new AppError(
    C.REMITTANCE_EXCEEDS_BALANCE,
    `The agent holds ${balance} in COD cash; the remittance can't exceed it`,
    S.UNPROCESSABLE_ENTITY,
  );

/** No payable account yet counts as a balance of 0 (spec 12 FI-6). */
export const payoutExceedsBalance = (balance: string) =>
  new AppError(
    C.PAYOUT_EXCEEDS_BALANCE,
    `The payee is owed ${balance}; the payout can't exceed it`,
    S.UNPROCESSABLE_ENTITY,
  );

export const payeeNotFound = () =>
  new AppError(C.PAYEE_NOT_FOUND, 'No seller or agent with this id', S.UNPROCESSABLE_ENTITY);

export const payoutAlreadyRecorded = () =>
  new AppError(
    C.PAYOUT_ALREADY_RECORDED,
    'A payout with this external reference is already recorded for this payee',
    S.CONFLICT,
  );

export const paidAtInFuture = () =>
  new AppError(C.PAID_AT_IN_FUTURE, 'paidAt cannot be in the future', S.UNPROCESSABLE_ENTITY);

/** Referenced from a request body (422). */
export const agentReferenceNotFound = () =>
  new AppError(C.AGENT_NOT_FOUND, 'Delivery agent not found', S.UNPROCESSABLE_ENTITY);

/** Races behind the friendly checks still map to the same codes (CLAUDE.md §6.4). */
export function registerFinanceConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('fk_cod_remittances_agent_id', agentReferenceNotFound);
  mapper.register('uq_payouts_payee_type_payee_id_external_reference', payoutAlreadyRecorded);
}

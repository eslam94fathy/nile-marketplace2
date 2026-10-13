import { AppError, governorateReferenceNotFound, internalError, type PgErrorMapper } from '../../lib/error';
import { HTTP_STATUS } from '../../lib/http';

/** delivery error codes (docs/spec/11-delivery.md §6; GOVERNORATE_NOT_FOUND is common, DE-4). */
export const DeliveryErrorCode = {
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_INACTIVE: 'AGENT_INACTIVE',
  AGENT_HAS_ACTIVE_SHIPMENTS: 'AGENT_HAS_ACTIVE_SHIPMENTS',
  AGENT_INVALID_STATUS_TRANSITION: 'AGENT_INVALID_STATUS_TRANSITION',
  SHIPMENT_NOT_FOUND: 'SHIPMENT_NOT_FOUND',
  SHIPMENT_INVALID_STATUS_TRANSITION: 'SHIPMENT_INVALID_STATUS_TRANSITION',
  SHIPMENT_NOT_ASSIGNABLE: 'SHIPMENT_NOT_ASSIGNABLE',
  SHIPMENT_ALREADY_ASSIGNED_TO_AGENT: 'SHIPMENT_ALREADY_ASSIGNED_TO_AGENT',
  COD_AMOUNT_MISMATCH: 'COD_AMOUNT_MISMATCH',
  COD_AMOUNT_REQUIRED: 'COD_AMOUNT_REQUIRED',
  COD_AMOUNT_NOT_ALLOWED: 'COD_AMOUNT_NOT_ALLOWED',
} as const;

const C = DeliveryErrorCode;
const S = HTTP_STATUS;

/** In the path (404). */
export const agentNotFound = () => new AppError(C.AGENT_NOT_FOUND, 'Delivery agent not found', S.NOT_FOUND);

/** Referenced from a request body (422). */
export const agentReferenceNotFound = () =>
  new AppError(C.AGENT_NOT_FOUND, 'Delivery agent not found', S.UNPROCESSABLE_ENTITY);

/** An inactive agent goes on shift or is chosen for an assignment (409). */
export const agentInactive = () =>
  new AppError(C.AGENT_INACTIVE, 'This delivery agent is inactive', S.CONFLICT);

/** An inactive agent calls an agent endpoint other than the profile (403, DE-5). */
export const agentInactiveForbidden = () =>
  new AppError(C.AGENT_INACTIVE, 'Your delivery account is inactive', S.FORBIDDEN);

export const agentHasActiveShipments = (count: number) =>
  new AppError(
    C.AGENT_HAS_ACTIVE_SHIPMENTS,
    `The agent still has ${count} active shipment(s); reassign them first`,
    S.CONFLICT,
  );

export const agentInvalidStatusTransition = (status: string) =>
  new AppError(C.AGENT_INVALID_STATUS_TRANSITION, `The agent is already ${status}`, S.CONFLICT);

/** Missing, or another agent's: never tell them apart. */
export const shipmentNotFound = () => new AppError(C.SHIPMENT_NOT_FOUND, 'Shipment not found', S.NOT_FOUND);

export const shipmentInvalidStatusTransition = (status: string) =>
  new AppError(
    C.SHIPMENT_INVALID_STATUS_TRANSITION,
    `This action is not allowed while the shipment is ${status}`,
    S.CONFLICT,
  );

/** S-18: no (re)assignment once the parcel is with an agent. */
export const shipmentNotAssignable = (status: string) =>
  new AppError(C.SHIPMENT_NOT_ASSIGNABLE, `A ${status} shipment can no longer be assigned`, S.CONFLICT);

export const shipmentAlreadyAssignedToAgent = () =>
  new AppError(
    C.SHIPMENT_ALREADY_ASSIGNED_TO_AGENT,
    'The shipment is already assigned to this agent',
    S.CONFLICT,
  );

export const codAmountMismatch = (expected: string) =>
  new AppError(
    C.COD_AMOUNT_MISMATCH,
    'The collected amount differs from the amount to collect',
    S.UNPROCESSABLE_ENTITY,
    {
      details: [
        {
          field: 'codCollectedAmount',
          value: expected,
          constraint: 'equals',
          message: `expected: ${expected}`,
        },
      ],
    },
  );

export const codAmountRequired = () =>
  new AppError(
    C.COD_AMOUNT_REQUIRED,
    'A cash on delivery shipment needs the collected amount',
    S.UNPROCESSABLE_ENTITY,
  );

export const codAmountNotAllowed = () =>
  new AppError(C.COD_AMOUNT_NOT_ALLOWED, 'A prepaid shipment collects no cash', S.UNPROCESSABLE_ENTITY);

/** The route already required the role, and the agent is created with the user, so this is a bug. */
export const agentProfileMissing = (userId: string) =>
  internalError(new Error(`delivery_agent-role user ${userId} has no agent profile`));

export function registerDeliveryConstraintErrors(mapper: PgErrorMapper): void {
  mapper.register('fk_delivery_agents_home_governorate_id', governorateReferenceNotFound);
}

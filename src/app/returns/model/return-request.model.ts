import { type Money, type Rate } from '../../../lib/money';
import {
  type PhotoUploader,
  type RefundPayoutMethod,
  type ReturnActorRole,
  type ReturnFeePayer,
  type ReturnReason,
  type ReturnRefusalReason,
  type ReturnStatus,
} from '../enums';

/** One return request (spec 18 §1). The payout ciphertext never leaves the module except in `return.completed`. */
export interface ReturnRequest {
  id: string;
  returnNumber: string;
  sellerOrderId: string;
  orderId: string;
  customerId: string;
  sellerId: string;
  status: ReturnStatus;
  reason: ReturnReason;
  description: string | null;
  returnFee: Money;
  returnFeePayer: ReturnFeePayer;
  agentShareRate: Rate;
  /** Estimated until completed, then final. */
  refundAmount: Money;
  refundPayoutMethod: RefundPayoutMethod | null;
  hasRefundPayout: boolean;
  agentId: string | null;
  rejectionReason: string | null;
  refusalReason: ReturnRefusalReason | null;
  escalationNote: string | null;
  disputeReason: string | null;
  sellerDecisionDeadlineAt: Date | null;
  escalationDeadlineAt: Date | null;
  inspectionDeadlineAt: Date | null;
  approvedAt: Date | null;
  receivedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface NewReturnRequest {
  sellerOrderId: string;
  orderId: string;
  customerId: string;
  sellerId: string;
  reason: ReturnReason;
  description: string | null;
  returnFee: Money;
  returnFeePayer: ReturnFeePayer;
  agentShareRate: Rate;
  refundAmount: Money;
  refundPayoutMethod: RefundPayoutMethod | null;
  sellerDecisionDeadlineAt: Date;
}

/** What a transition writes besides the status; undefined fields stay as they are. */
export interface ReturnPatch {
  status: ReturnStatus;
  rejectionReason?: string;
  refusalReason?: ReturnRefusalReason;
  escalationNote?: string;
  escalationDeadlineAt?: Date;
  approvedAt?: Date;
  agentId?: string;
  receivedAt?: Date;
  inspectionDeadlineAt?: Date;
  disputeReason?: string;
  completedAt?: Date;
  /** Final at completion (UC-RE-7 step 4). */
  refundAmount?: Money;
  /** The request ends: the payout ciphertext goes (RE-8); the method stays for the admin view. */
  clearRefundPayout?: true;
}

export interface ReturnItem {
  id: string;
  returnId: string;
  orderItemId: string;
  quantity: number;
  /** The seller's choice at receipt; null until the return completes. */
  restock: boolean | null;
}

export interface ReturnPhoto {
  returnId: string;
  mediaId: string;
  uploadedBy: PhotoUploader;
  position: number;
}

export interface ReturnHistoryEntry {
  returnId: string;
  fromStatus: ReturnStatus | null;
  toStatus: ReturnStatus;
  actorRole: ReturnActorRole;
  actorUserId: string | null;
  reason: string | null;
  createdAt: Date;
}

/** Who moved a return: the history row and the event's `actor`. */
export interface ReturnActor {
  role: ReturnActorRole;
  /** null = system, or an actor known only by a profile id (an agent). */
  userId: string | null;
}

/** The COD payout details as sealed (RE-8). Never logged (redaction keys `walletNumber`, `instapayAddress`). */
export type RefundPayout =
  | { method: typeof RefundPayoutMethod.MOBILE_WALLET; walletNumber: string }
  | { method: typeof RefundPayoutMethod.INSTAPAY; instapayAddress: string };

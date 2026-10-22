export const RETURNS_TABLES = {
  REQUESTS: 'return_requests',
  ITEMS: 'return_items',
  PHOTOS: 'return_photos',
  STATUS_HISTORY: 'return_status_history',
} as const;

/** Spec 18 §1 limits (constants; the windows and deadlines are env). */
export const RETURN_LIMITS = {
  DESCRIPTION_MIN: 1,
  DESCRIPTION_MAX: 1000,
  MAX_PHOTOS: 4,
  NOTE_MIN: 3,
  NOTE_MAX: 500,
  MAX_ITEMS: 50,
  MAX_ITEM_QUANTITY: 99,
  INSTAPAY_ADDRESS_MIN: 3,
  INSTAPAY_ADDRESS_MAX: 100,
} as const;

/** `'R-' || lpad(nextval(...)::text, 9, '0')` (RE-21, as tickets). */
export const RETURN_NUMBER = {
  SEQUENCE: 'return_number_seq',
  PREFIX: 'R-',
  DIGITS: 9,
} as const;

/**
 * AAD of the sealed COD payout details (S-1 box, spec 02 §3.1): bound to the return, so a ciphertext
 * can't be moved to another request. Payments opens it with the same string (spec 10 §8.4).
 */
export const refundPayoutAad = (returnId: string): string => `${returnId}:refund_payout`;

/** Paths under /api/v1 (spec 18 §4.1). */
export const RETURN_PATHS = {
  RETURNABLE_ITEMS: '/orders/:orderId/seller-orders/:sellerOrderId/returnable-items',
  RETURNS: '/returns',
  RETURN: '/returns/:returnId',
  CANCEL: '/returns/:returnId/cancel',
  ESCALATE: '/returns/:returnId/escalate',
} as const;

/** Paths under /api/v1 (spec 18 §4.2); receipt and dispute come with the shipment flow (R2-P6 step 5). */
export const SELLER_RETURN_PATHS = {
  RETURNS: '/seller/returns',
  RETURN: '/seller/returns/:returnId',
  APPROVE: '/seller/returns/:returnId/approve',
  REJECT: '/seller/returns/:returnId/reject',
} as const;

/** Paths under /api/v1 (spec 18 §4.3); resolve-dispute comes with the dispute (R2-P6 step 5). */
export const ADMIN_RETURN_PATHS = {
  RETURNS: '/admin/returns',
  RETURN: '/admin/returns/:returnId',
  DECIDE: '/admin/returns/:returnId/decide',
} as const;

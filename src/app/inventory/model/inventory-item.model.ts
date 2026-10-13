/** Stock of one variant, as other modules see it (spec 07 §2). */
export interface StockDto {
  variantId: string;
  onHand: number;
  reserved: number;
  /** on_hand - reserved */
  sellable: number;
}

export interface InventoryItemProps {
  id: string;
  variantId: string;
  onHand: number;
  reserved: number;
}

export class InventoryItem {
  constructor(private readonly props: InventoryItemProps) {}

  get id(): string {
    return this.props.id;
  }
  get variantId(): string {
    return this.props.variantId;
  }
  get onHand(): number {
    return this.props.onHand;
  }
  get reserved(): number {
    return this.props.reserved;
  }
  get sellable(): number {
    return this.props.onHand - this.props.reserved;
  }

  toStock(): StockDto {
    return {
      variantId: this.variantId,
      onHand: this.onHand,
      reserved: this.reserved,
      sellable: this.sellable,
    };
  }
}

/**
 * `inventory.stock_status_changed` is emitted only when sellable stock crosses 0, in either
 * direction (spec 07 §2). Returns the new in-stock state, or null when nothing crossed.
 */
export function stockStatusChange(
  sellableBefore: number,
  sellableAfter: number,
): { inStock: boolean } | null {
  const before = sellableBefore > 0;
  const after = sellableAfter > 0;
  return before === after ? null : { inStock: after };
}

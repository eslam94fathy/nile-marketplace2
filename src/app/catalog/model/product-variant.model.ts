import { type Money } from '../../../lib/money';
import { VariantStatus } from '../enums';

/** The option a variant has for one attribute, with display data (joined within catalog). */
export interface VariantOptionValue {
  attributeId: string;
  attributeCode: string;
  optionId: string;
  optionCode: string;
  value: string;
}

export interface ProductVariantProps {
  id: string;
  productId: string;
  sellerId: string;
  sku: string;
  price: Money;
  compareAtPrice: Money | null;
  status: VariantStatus;
  optionSignature: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class ProductVariant {
  constructor(private readonly props: ProductVariantProps) {}

  get id(): string {
    return this.props.id;
  }
  get productId(): string {
    return this.props.productId;
  }
  get sellerId(): string {
    return this.props.sellerId;
  }
  get sku(): string {
    return this.props.sku;
  }
  get price(): Money {
    return this.props.price;
  }
  get compareAtPrice(): Money | null {
    return this.props.compareAtPrice;
  }
  get status(): VariantStatus {
    return this.props.status;
  }
  get optionSignature(): string {
    return this.props.optionSignature;
  }
  get isDefault(): boolean {
    return this.props.isDefault;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  get isActive(): boolean {
    return this.status === VariantStatus.ACTIVE;
  }
}

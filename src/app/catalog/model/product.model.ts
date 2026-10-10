import { type Money } from '../../../lib/money';
import { ProductStatus } from '../enums';

export interface ProductProps {
  id: string;
  sellerId: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string;
  status: ProductStatus;
  /** Projection of the seller's status (= approved). */
  sellerActive: boolean;
  minPrice: Money | null;
  maxPrice: Money | null;
  inStock: boolean;
  publishedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `draft → active ⇄ inactive` (overview §4.2). */
const TRANSITIONS: Readonly<Record<ProductStatus, readonly ProductStatus[]>> = {
  [ProductStatus.DRAFT]: [ProductStatus.ACTIVE],
  [ProductStatus.ACTIVE]: [ProductStatus.INACTIVE],
  [ProductStatus.INACTIVE]: [ProductStatus.ACTIVE],
};

export class Product {
  constructor(private readonly props: ProductProps) {}

  get id(): string {
    return this.props.id;
  }
  get sellerId(): string {
    return this.props.sellerId;
  }
  get categoryId(): string {
    return this.props.categoryId;
  }
  get name(): string {
    return this.props.name;
  }
  get slug(): string {
    return this.props.slug;
  }
  get description(): string {
    return this.props.description;
  }
  get status(): ProductStatus {
    return this.props.status;
  }
  get sellerActive(): boolean {
    return this.props.sellerActive;
  }
  get minPrice(): Money | null {
    return this.props.minPrice;
  }
  get maxPrice(): Money | null {
    return this.props.maxPrice;
  }
  get inStock(): boolean {
    return this.props.inStock;
  }
  get publishedAt(): Date | null {
    return this.props.publishedAt;
  }
  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }

  /** VIS (02-database.md §5): what the public sees. */
  get visible(): boolean {
    return this.status === ProductStatus.ACTIVE && this.sellerActive && this.deletedAt === null;
  }

  canTransitionTo(next: ProductStatus): boolean {
    return TRANSITIONS[this.status].includes(next);
  }
}

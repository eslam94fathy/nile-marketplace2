import { type Rate } from '../../../lib/money';
import { type SellerStatus } from '../enums';

/** Where agents collect the seller's parcels; snapshotted per seller order at checkout. */
export interface PickupAddress {
  governorateId: string;
  city: string;
  area: string;
  street: string;
  building: string;
  landmark: string | null;
}

export interface SellerProps {
  id: string;
  userId: string;
  businessName: string;
  contactPhone: string;
  pickup: PickupAddress;
  status: SellerStatus;
  commissionRate: Rate;
  rejectionReason: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Seller {
  constructor(private readonly props: SellerProps) {}

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get businessName(): string {
    return this.props.businessName;
  }
  get contactPhone(): string {
    return this.props.contactPhone;
  }
  get pickup(): PickupAddress {
    return this.props.pickup;
  }
  get status(): SellerStatus {
    return this.props.status;
  }
  get commissionRate(): Rate {
    return this.props.commissionRate;
  }
  get rejectionReason(): string | null {
    return this.props.rejectionReason;
  }
  get approvedAt(): Date | null {
    return this.props.approvedAt;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}

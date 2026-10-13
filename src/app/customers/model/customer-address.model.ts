/** The editable fields of an address (spec 04 §4.3). */
export interface AddressFields {
  label: string;
  recipientName: string;
  recipientPhone: string;
  governorateId: string;
  city: string;
  area: string;
  street: string;
  building: string;
  floor: string | null;
  apartment: string | null;
  landmark: string | null;
}

export interface CustomerAddressProps extends AddressFields {
  id: string;
  customerId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** What ordering copies onto the order at checkout (spec 04 §2). */
export type AddressSnapshot = Omit<AddressFields, 'label'>;

/** A live (not deleted) address: repositories filter deleted rows out. */
export class CustomerAddress {
  constructor(private readonly props: CustomerAddressProps) {}

  get id(): string {
    return this.props.id;
  }
  get customerId(): string {
    return this.props.customerId;
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
  get fields(): AddressFields {
    const { id: _id, customerId: _c, isDefault: _d, createdAt: _cr, updatedAt: _u, ...fields } = this.props;
    return fields;
  }

  toSnapshot(): AddressSnapshot {
    const { label: _label, ...snapshot } = this.fields;
    return snapshot;
  }
}

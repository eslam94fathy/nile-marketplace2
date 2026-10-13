import { Money } from '../../../lib/money';

export interface GovernorateProps {
  id: string;
  /** ISO 3166-2:EG, never changes; the app localizes the name by it (spec 11 DE-1). */
  code: string;
  name: string;
  /** null = not deliverable (Q-26). */
  deliveryFee: Money | null;
}

/** Plain JSON form kept in the cache. */
export interface GovernorateSnapshot {
  id: string;
  code: string;
  name: string;
  deliveryFee: string | null;
}

export class Governorate {
  constructor(private readonly props: GovernorateProps) {}

  static fromSnapshot(snapshot: GovernorateSnapshot): Governorate {
    return new Governorate({
      ...snapshot,
      deliveryFee: snapshot.deliveryFee === null ? null : Money.of(snapshot.deliveryFee),
    });
  }

  get id(): string {
    return this.props.id;
  }
  get code(): string {
    return this.props.code;
  }
  get name(): string {
    return this.props.name;
  }
  get deliveryFee(): Money | null {
    return this.props.deliveryFee;
  }
  /** Only governorates with a fee are deliverable (Q-26). */
  get isDeliverable(): boolean {
    return this.props.deliveryFee !== null;
  }

  toSnapshot(): GovernorateSnapshot {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      deliveryFee: this.deliveryFee?.toString() ?? null,
    };
  }
}

import { type Rate } from '../../../lib/money';

/** The single `delivery_settings` row (spec 11 UC-DE-7). */
export class DeliverySettings {
  constructor(
    private readonly props: {
      /** Agents' share of the delivery fee (Q-23b, Q-34); snapshotted per order at checkout. */
      agentFeeShareRate: Rate;
      updatedAt: Date;
    },
  ) {}

  get agentFeeShareRate(): Rate {
    return this.props.agentFeeShareRate;
  }
  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}

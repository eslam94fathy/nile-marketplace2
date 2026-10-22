import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { ShipmentStatus } from '../enums';
import { type ShipmentRepository } from '../repository/shipment.repository';

/** Delivery's part of the dashboard (spec 20 §3.2). */
export interface DeliveryDashboardStats {
  awaitingAssignment: number;
  outForDelivery: number;
  /** Return shipments not yet `delivered` or `cancelled` (spec 11 §8.4, BO-24). */
  returnsInProgress: number;
}

/** Public API of delivery for the back-office (spec 20 §3.2) and returns (DE-23). Reads without locks. */
export interface IShipmentDirectory {
  getDashboardStats(): Promise<DeliveryDashboardStats>;
  /** The return's shipment status; null when there is none (yet). */
  getReturnShipmentStatus(returnId: string): Promise<ShipmentStatus | null>;
}

@injectable()
export class ShipmentDirectory implements IShipmentDirectory {
  constructor(@inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository) {}

  getReturnShipmentStatus(returnId: string): Promise<ShipmentStatus | null> {
    return this.shipments.findStatusByReturnId(returnId);
  }

  async getDashboardStats(): Promise<DeliveryDashboardStats> {
    const [counts, returnsInProgress] = await Promise.all([
      this.shipments.countByStatuses([ShipmentStatus.UNASSIGNED, ShipmentStatus.OUT_FOR_DELIVERY]),
      this.shipments.countReturnsInProgress(),
    ]);
    return {
      awaitingAssignment: counts.get(ShipmentStatus.UNASSIGNED) ?? 0,
      outForDelivery: counts.get(ShipmentStatus.OUT_FOR_DELIVERY) ?? 0,
      returnsInProgress,
    };
  }
}

import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { ShipmentStatus } from '../enums';
import { type ShipmentRepository } from '../repository/shipment.repository';

/** Delivery's part of the dashboard (spec 20 §3.2). */
export interface DeliveryDashboardStats {
  awaitingAssignment: number;
  outForDelivery: number;
}

/** Public API of delivery for the back-office (spec 20 §3.2). Reads without locks. */
export interface IShipmentDirectory {
  getDashboardStats(): Promise<DeliveryDashboardStats>;
}

@injectable()
export class ShipmentDirectory implements IShipmentDirectory {
  constructor(@inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository) {}

  async getDashboardStats(): Promise<DeliveryDashboardStats> {
    const counts = await this.shipments.countByStatuses([
      ShipmentStatus.UNASSIGNED,
      ShipmentStatus.OUT_FOR_DELIVERY,
    ]);
    return {
      awaitingAssignment: counts.get(ShipmentStatus.UNASSIGNED) ?? 0,
      outForDelivery: counts.get(ShipmentStatus.OUT_FOR_DELIVERY) ?? 0,
    };
  }
}

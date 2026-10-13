import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { shipmentNotFound } from '../errors';
import { type Shipment, type ShipmentAttempt, type ShipmentHistoryEntry } from '../model/shipment.model';
import { type ShipmentHistoryRepository } from '../repository/shipment-history.repository';
import { type ShipmentRepository } from '../repository/shipment.repository';

export interface ShipmentView {
  shipment: Shipment;
  attempts: ShipmentAttempt[];
  history: ShipmentHistoryEntry[];
}

/** Shipment reads (spec 11 §4.2, §4.3): attempts and history with one batched query each (G20). */
@injectable()
export class ShipmentViewService {
  constructor(
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.ShipmentHistoryRepository) private readonly history: ShipmentHistoryRepository,
  ) {}

  async get(shipmentId: string): Promise<ShipmentView> {
    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw shipmentNotFound();
    const [view] = await this.viewsOf([shipment], true);
    if (!view) throw shipmentNotFound();
    return view;
  }

  /** Another agent's shipment is not found (spec 11 UC-DE-3). */
  async getForAgent(agentId: string, shipmentId: string): Promise<ShipmentView> {
    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment || shipment.agentId !== agentId) throw shipmentNotFound();
    return this.viewOf(shipment);
  }

  async listForAgent(
    agentId: string,
    query: ParsedListQuery,
  ): Promise<{ items: ShipmentView[]; meta: PageMeta }> {
    const page = toPage(await this.shipments.listForAgent(agentId, query), query, (s) => s.createdAt);
    return { items: await this.viewsOf(page.items, false), meta: page.meta };
  }

  /** One shipment after a change, without its history (the agent's response). */
  async viewOf(shipment: Shipment): Promise<ShipmentView> {
    const [view] = await this.viewsOf([shipment], false);
    if (!view) throw shipmentNotFound();
    return view;
  }

  async listForAdmin(query: ParsedListQuery): Promise<{ items: ShipmentView[]; meta: PageMeta }> {
    const page = toPage(await this.shipments.list(query), query, (shipment) => shipment.createdAt);
    return { items: await this.viewsOf(page.items, false), meta: page.meta };
  }

  async viewsOf(shipments: readonly Shipment[], withHistory: boolean): Promise<ShipmentView[]> {
    const ids = shipments.map((s) => s.id);
    const [attempts, history] = await Promise.all([
      this.history.attemptsFor(ids),
      withHistory ? this.history.listFor(ids) : Promise.resolve([]),
    ]);
    return shipments.map((shipment) => ({
      shipment,
      attempts: attempts.filter((a) => a.shipmentId === shipment.id),
      history: history.filter((h) => h.shipmentId === shipment.id),
    }));
  }
}

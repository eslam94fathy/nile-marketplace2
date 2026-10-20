import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type IClock } from '../../../lib/clock';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ShipmentAssigned } from '../../../lib/events';
import { type ILogger } from '../../../lib/logger';
import { AgentStatus, DeliveryActorRole, ShipmentStatus } from '../enums';
import {
  agentInactive,
  agentReferenceNotFound,
  shipmentAlreadyAssignedToAgent,
  shipmentNotAssignable,
  shipmentNotFound,
} from '../errors';
import { type DeliveryActor, type Shipment } from '../model/shipment.model';
import { type DeliveryAgentRepository } from '../repository/delivery-agent.repository';
import { type ShipmentHistoryRepository } from '../repository/shipment-history.repository';
import { type ShipmentRepository } from '../repository/shipment.repository';

const SYSTEM: DeliveryActor = { role: DeliveryActorRole.SYSTEM, userId: null };
/** Q-41, S-18: (re)assignment only before the parcel is picked up. */
const ASSIGNABLE: readonly ShipmentStatus[] = [ShipmentStatus.UNASSIGNED, ShipmentStatus.ASSIGNED];

/**
 * Assignment (spec 11 UC-DE-1, UC-DE-4), shared by the creation consumer, the retry job (worker)
 * and the admin endpoint (api). The shipment is locked before the agent (DE-7).
 */
@injectable()
export class ShipmentAssignmentService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.ShipmentRepository) private readonly shipments: ShipmentRepository,
    @inject(TOKENS.DeliveryAgentRepository) private readonly agents: DeliveryAgentRepository,
    @inject(TOKENS.ShipmentHistoryRepository) private readonly history: ShipmentHistoryRepository,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
  ) {}

  /**
   * UC-DE-1 steps 2–3 on an `unassigned` shipment the caller has locked: the best candidate of the
   * pickup governorate, or nothing (it stays `unassigned` for the retry job). Returns the result.
   */
  async autoAssign(shipment: Shipment, trx: DbTransaction): Promise<Shipment | null> {
    if (shipment.status !== ShipmentStatus.UNASSIGNED) return null;
    const agent = await this.agents.lockCandidate(shipment.pickup.governorateId, trx);
    if (!agent) {
      this.logger.info('no agent available; the shipment waits for the retry job', {
        event: 'SHIPMENT_UNASSIGNED',
        shipmentId: shipment.id,
        governorateId: shipment.pickup.governorateId,
      });
      return null;
    }
    return this.assign(shipment, agent.id, 'auto', SYSTEM, trx);
  }

  /** UC-DE-4: assign or reassign before pickup, to any active agent (the admin may override shift and area). */
  async adminAssign(shipmentId: string, agentId: string, adminUserId: string): Promise<Shipment> {
    return this.tx.run(async (trx) => {
      const shipment = await this.shipments.lockById(shipmentId, trx);
      if (!shipment) throw shipmentNotFound();
      if (!ASSIGNABLE.includes(shipment.status)) throw shipmentNotAssignable(shipment.status);
      if (shipment.agentId === agentId) throw shipmentAlreadyAssignedToAgent();
      const agent = await this.agents.lockById(agentId, trx);
      if (!agent) throw agentReferenceNotFound();
      if (agent.status !== AgentStatus.ACTIVE) throw agentInactive();
      const assigned = await this.assign(
        shipment,
        agent.id,
        'admin',
        { role: DeliveryActorRole.ADMIN, userId: adminUserId },
        trx,
      );
      await this.audit.record(
        {
          action: 'shipment.admin_assigned',
          targetId: shipment.id,
          before: { agentId: shipment.agentId },
          after: { agentId: agent.id },
        },
        trx,
      );
      return assigned;
    });
  }

  /** The retry job (DE-9): one short transaction per shipment, skipping one another transaction holds. */
  async retry(shipmentId: string): Promise<boolean> {
    return this.tx.run(async (trx) => {
      const shipment = await this.shipments.lockById(shipmentId, trx, { skipLocked: true });
      if (!shipment) return false;
      return (await this.autoAssign(shipment, trx)) !== null;
    });
  }

  private async assign(
    shipment: Shipment,
    agentId: string,
    assignedBy: 'auto' | 'admin',
    actor: DeliveryActor,
    trx: DbTransaction,
  ): Promise<Shipment> {
    const now = this.clock.now();
    const assigned = await this.shipments.transition(
      shipment.id,
      ASSIGNABLE,
      { status: ShipmentStatus.ASSIGNED, agentId, assignedAt: now },
      trx,
    );
    if (!assigned) throw new Error(`shipment ${shipment.id} changed under its lock`);
    await this.agents.setLastAssignedAt(agentId, now, trx);
    await this.history.add(
      {
        shipmentId: shipment.id,
        fromStatus: shipment.status,
        toStatus: ShipmentStatus.ASSIGNED,
        actorRole: actor.role,
        actorUserId: actor.userId,
        reason: assignedBy === 'admin' && shipment.agentId ? 'reassigned' : null,
      },
      trx,
    );
    await this.outbox.add(trx, {
      contract: ShipmentAssigned,
      aggregateId: shipment.id,
      payload: {
        shipmentId: shipment.id,
        sellerOrderId: shipment.sellerOrderId,
        agentId,
        previousAgentId: shipment.agentId,
        assignedBy,
      },
    });
    this.logger.info('shipment assigned', {
      event: 'SHIPMENT_ASSIGNED',
      shipmentId: shipment.id,
      agentId,
      previousAgentId: shipment.agentId,
      assignedBy,
    });
    return assigned;
  }
}

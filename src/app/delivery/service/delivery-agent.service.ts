import { inject, injectable } from 'tsyringe';
import { type AuditAction, type AuditValues, type IAuditRecorder } from '../../../lib/audit';
import { type DbTransaction, type ITransactionRunner } from '../../../lib/db';
import { UserRole } from '../../../lib/auth';
import { TOKENS } from '../../../lib/di';
import { type PageMeta, type ParsedListQuery, toPage } from '../../../lib/http';
import { type ILogger } from '../../../lib/logger';
import { type IAccountService, UserStatus } from '../../identity';
import { AgentStatus } from '../enums';
import {
  agentHasActiveShipments,
  agentInactive,
  agentInactiveForbidden,
  agentInvalidStatusTransition,
  agentNotFound,
  agentProfileMissing,
} from '../errors';
import { type AgentView, type DeliveryAgent } from '../model/delivery-agent.model';
import { type DeliveryAgentRepository } from '../repository/delivery-agent.repository';

export interface NewAgent {
  email: string;
  fullName: string;
  phone: string;
  homeGovernorateId: string;
}

export type AgentProfileChanges = Partial<Pick<NewAgent, 'fullName' | 'phone' | 'homeGovernorateId'>>;

/**
 * Agents (spec 11 UC-DE-2, UC-DE-6): created by admins with an invited login, the availability toggle,
 * activation and deactivation (S-10, DE-5), and the views. Writes lock the agent row (DE-7).
 */
@injectable()
export class DeliveryAgentService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
    @inject(TOKENS.DeliveryAgentRepository) private readonly agents: DeliveryAgentRepository,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
  ) {}

  /** The invited login and the agent in one transaction; identity sends the invite email. */
  async create(input: NewAgent): Promise<AgentView> {
    const agent = await this.tx.run(async (trx) => {
      const { userId } = await this.accounts.createInvitedUser(
        { email: input.email, role: UserRole.DELIVERY_AGENT },
        trx,
      );
      const created = await this.agents.insert({ ...input, userId }, trx);
      await this.audit.record(
        { action: 'delivery_agent.created', targetId: created.id, after: agentValues(created) },
        trx,
      );
      return created;
    });
    this.logger.info('delivery agent created', { event: 'DELIVERY_AGENT_CREATED', agentId: agent.id });
    return this.viewOf(agent);
  }

  async update(agentId: string, changes: AgentProfileChanges): Promise<AgentView> {
    const agent = await this.tx.run(async (trx) => {
      const current = await this.agents.lockById(agentId, trx);
      if (!current) throw agentNotFound();
      const updated = await this.agents.update(agentId, changes, trx);
      await this.recordChange('delivery_agent.updated', current, updated, trx);
      return updated;
    });
    return this.viewOf(agent);
  }

  /**
   * Only with no active shipments (the admin reassigns first). Suspends the login when it is
   * `active` (S-10); an `invited` login is left as is, the guard keeps it out (DE-5).
   */
  async deactivate(agentId: string, actorUserId: string): Promise<AgentView> {
    const agent = await this.tx.run(async (trx) => {
      const current = await this.agents.lockById(agentId, trx);
      if (!current) throw agentNotFound();
      if (current.status === AgentStatus.INACTIVE) throw agentInvalidStatusTransition(current.status);
      const active = (await this.agents.activeShipmentCounts([agentId], trx)).get(agentId) ?? 0;
      if (active > 0) throw agentHasActiveShipments(active);
      const updated = await this.agents.update(
        agentId,
        { status: AgentStatus.INACTIVE, onShift: false },
        trx,
      );
      if ((await this.userStatusOf(current)) === UserStatus.ACTIVE) {
        await this.accounts.setUserStatus(current.userId, UserStatus.SUSPENDED, actorUserId, trx);
      }
      await this.recordChange('delivery_agent.deactivated', current, updated, trx);
      return updated;
    });
    this.logger.info('delivery agent deactivated', { event: 'DELIVERY_AGENT_DEACTIVATED', agentId });
    return this.viewOf(agent);
  }

  /** Reactivates the login only when deactivation suspended it (DE-5). */
  async activate(agentId: string, actorUserId: string): Promise<AgentView> {
    const agent = await this.tx.run(async (trx) => {
      const current = await this.agents.lockById(agentId, trx);
      if (!current) throw agentNotFound();
      if (current.status === AgentStatus.ACTIVE) throw agentInvalidStatusTransition(current.status);
      const updated = await this.agents.update(agentId, { status: AgentStatus.ACTIVE }, trx);
      if ((await this.userStatusOf(current)) === UserStatus.SUSPENDED) {
        await this.accounts.setUserStatus(current.userId, UserStatus.ACTIVE, actorUserId, trx);
      }
      await this.recordChange('delivery_agent.activated', current, updated, trx);
      return updated;
    });
    this.logger.info('delivery agent activated', { event: 'DELIVERY_AGENT_ACTIVATED', agentId });
    return this.viewOf(agent);
  }

  /** UC-DE-2: going off shift keeps current shipments; it only stops new auto-assignments. */
  async setAvailability(agent: DeliveryAgent, onShift: boolean): Promise<AgentView> {
    const updated = await this.tx.run(async (trx) => {
      const current = await this.agents.lockById(agent.id, trx);
      if (!current) throw agentProfileMissing(agent.userId);
      if (current.status !== AgentStatus.ACTIVE) throw agentInactive();
      return this.agents.update(agent.id, { onShift }, trx);
    });
    return this.viewOf(updated);
  }

  /** The caller's agent profile, in any status (`GET /agent/profile`). */
  async agentOfUser(userId: string): Promise<DeliveryAgent> {
    const agent = await this.agents.findByUserId(userId);
    if (!agent) throw agentProfileMissing(userId);
    return agent;
  }

  /** Every agent endpoint but the profile needs an active agent (DE-5). */
  async activeAgentOfUser(userId: string): Promise<DeliveryAgent> {
    const agent = await this.agentOfUser(userId);
    if (agent.status !== AgentStatus.ACTIVE) throw agentInactiveForbidden();
    return agent;
  }

  async get(agentId: string): Promise<AgentView> {
    const agent = await this.agents.findById(agentId);
    if (!agent) throw agentNotFound();
    return this.viewOf(agent);
  }

  async list(query: ParsedListQuery): Promise<{ items: AgentView[]; meta: PageMeta }> {
    const page = toPage(await this.agents.list(query), query, (agent) => agent.createdAt);
    return { items: await this.viewsOf(page.items), meta: page.meta };
  }

  /** The audit row of an agent write (spec 20 §2.3), in its transaction. */
  private recordChange(
    action: AuditAction,
    before: DeliveryAgent,
    after: DeliveryAgent,
    trx: DbTransaction,
  ): Promise<void> {
    return this.audit.record(
      { action, targetId: after.id, before: agentValues(before), after: agentValues(after) },
      trx,
    );
  }

  async viewOf(agent: DeliveryAgent): Promise<AgentView> {
    const [view] = await this.viewsOf([agent]);
    if (!view) throw new Error(`no view for agent ${agent.id}`);
    return view;
  }

  /** Logins and open work of many agents: two batched reads (G20). */
  private async viewsOf(agents: readonly DeliveryAgent[]): Promise<AgentView[]> {
    const [users, counts] = await Promise.all([
      this.accounts.getUsersByIds(agents.map((a) => a.userId)),
      this.agents.activeShipmentCounts(agents.map((a) => a.id)),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    return agents.map((agent) => {
      const user = userById.get(agent.userId);
      if (!user) throw new Error(`agent ${agent.id} has no user`);
      return {
        agent,
        email: user.email,
        userStatus: user.status,
        activeShipmentCount: counts.get(agent.id) ?? 0,
      };
    });
  }

  private async userStatusOf(agent: DeliveryAgent): Promise<string | undefined> {
    const [user] = await this.accounts.getUsersByIds([agent.userId]);
    return user?.status;
  }
}

/** Audited fields of an agent (spec 20 §2.3). The email belongs to identity and isn't recorded. */
function agentValues(agent: DeliveryAgent): AuditValues {
  return {
    fullName: agent.fullName,
    phone: agent.phone,
    homeGovernorateId: agent.homeGovernorateId,
    status: agent.status,
  };
}

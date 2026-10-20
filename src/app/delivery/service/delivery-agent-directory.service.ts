import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../lib/di';
import { type AgentStatus } from '../enums';
import { type DeliveryAgentRepository } from '../repository/delivery-agent.repository';

/**
 * Public API (spec 11 §2, DE-11; §8.4 R2): agent profiles for finance, and the agent → user id lookup
 * realtime and notifications use to reach an agent (spec 02 §6.3).
 */
export interface IDeliveryAgentDirectory {
  /** Profile resolution for `/agent/finance/*`; null when the user has no agent profile. */
  getAgentByUserId(userId: string): Promise<{ agentId: string; status: AgentStatus } | null>;
  /** Display data for admin finance views; one batched query, unknown ids left out. */
  getAgentSummaries(
    agentIds: readonly string[],
  ): Promise<{ agentId: string; fullName: string; phone: string }[]>;
  /** Recipient resolution; one batched query, unknown ids left out. */
  getUserIds(agentIds: readonly string[]): Promise<Map<string, string>>;
}

@injectable()
export class DeliveryAgentDirectory implements IDeliveryAgentDirectory {
  constructor(@inject(TOKENS.DeliveryAgentRepository) private readonly agents: DeliveryAgentRepository) {}

  async getAgentByUserId(userId: string): Promise<{ agentId: string; status: AgentStatus } | null> {
    const agent = await this.agents.findByUserId(userId);
    return agent ? { agentId: agent.id, status: agent.status } : null;
  }

  async getAgentSummaries(
    agentIds: readonly string[],
  ): Promise<{ agentId: string; fullName: string; phone: string }[]> {
    return (await this.agents.findByIds(agentIds)).map((agent) => ({
      agentId: agent.id,
      fullName: agent.fullName,
      phone: agent.phone,
    }));
  }

  getUserIds(agentIds: readonly string[]): Promise<Map<string, string>> {
    return this.agents.findUserIds(agentIds);
  }
}

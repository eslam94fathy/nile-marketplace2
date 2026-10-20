import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { TOKENS } from '../../../lib/di';
import { RealtimeRoom } from '../../../lib/realtime';
import { type ICustomerDirectory } from '../../customers';
import { type IDeliveryAgentDirectory } from '../../delivery';
import { type ISellerDirectory } from '../../sellers';

/**
 * UC-RT-1 step 4: the rooms a connecting user joins, from the profile of their role. Null when the
 * role's profile is missing (connect error FORBIDDEN). The profile's status doesn't matter here: the
 * socket only notifies, and REST still guards every read and write.
 */
@injectable()
export class ProfileRoomsService {
  constructor(
    @inject(TOKENS.CustomerDirectory) private readonly customers: ICustomerDirectory,
    @inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory,
    @inject(TOKENS.DeliveryAgentDirectory) private readonly agents: IDeliveryAgentDirectory,
  ) {}

  async roomsOf(userId: string, role: UserRole): Promise<string[] | null> {
    const roleRoom = await this.roleRoom(userId, role);
    return roleRoom === null ? null : [RealtimeRoom.user(userId), roleRoom];
  }

  private async roleRoom(userId: string, role: UserRole): Promise<string | null> {
    switch (role) {
      case UserRole.CUSTOMER: {
        const customerId = await this.customers.getCustomerIdByUserId(userId);
        return customerId === null ? null : RealtimeRoom.customer(customerId);
      }
      case UserRole.SELLER: {
        const seller = await this.sellers.getSellerByUserId(userId);
        return seller === null ? null : RealtimeRoom.seller(seller.sellerId);
      }
      case UserRole.DELIVERY_AGENT: {
        const agent = await this.agents.getAgentByUserId(userId);
        return agent === null ? null : RealtimeRoom.agent(agent.agentId);
      }
      case UserRole.ADMIN:
        return RealtimeRoom.ADMINS;
    }
  }
}

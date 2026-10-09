import { inject, injectable } from 'tsyringe';
import { UserRole } from '../../../lib/auth';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { forbidden } from '../../../lib/error';
import { type ILogger } from '../../../lib/logger';
import { type IAccountService } from '../../identity';
import { SellerStatus } from '../enums';
import { sellerInvalidStatusTransition } from '../errors';
import { type PickupAddress, type Seller } from '../model/seller.model';
import { type SellerSettingsRepository } from '../repository/seller-settings.repository';
import { type SellerStatusHistoryRepository } from '../repository/seller-status-history.repository';
import { type SellerProfilePatch, type SellerRepository } from '../repository/seller.repository';

export interface SellerRegistration {
  /** Already normalised by the DTO (trimmed, lower-cased). */
  email: string;
  password: string;
  businessName: string;
  contactPhone: string;
  pickup: PickupAddress;
}

export interface SellerProfile {
  seller: Seller;
  email: string;
}

/** Registration (UC-SE-1) and seller self-service (UC-SE-2, spec 05 §4.3). */
@injectable()
export class SellerService {
  constructor(
    @inject(TOKENS.SellerRepository) private readonly sellers: SellerRepository,
    @inject(TOKENS.SellerStatusHistoryRepository) private readonly history: SellerStatusHistoryRepository,
    @inject(TOKENS.SellerSettingsRepository) private readonly settings: SellerSettingsRepository,
    @inject(TOKENS.AccountService) private readonly accounts: IAccountService,
    @inject(TOKENS.TransactionRunner) private readonly transactions: ITransactionRunner,
    @inject(TOKENS.Logger) private readonly logger: ILogger,
  ) {}

  /**
   * EMAIL_ALREADY_REGISTERED (identity), BUSINESS_NAME_TAKEN and GOVERNORATE_NOT_FOUND come from the
   * constraint mappings; any of them rolls back the user, the seller and the OTP email together.
   */
  async register(input: SellerRegistration): Promise<{ userId: string; sellerId: string; email: string }> {
    // bcrypt before the transaction, so a slow hash never holds a connection or a lock (SE-1).
    const passwordHash = await this.accounts.hashPassword(input.password);
    const seller = await this.transactions.run(async (trx) => {
      const { userId } = await this.accounts.createPendingUser(
        { email: input.email, passwordHash, role: UserRole.SELLER },
        trx,
      );
      // Read inside the transaction: the default in force when this seller registers (UC-SE-3).
      const { defaultCommissionRate } = await this.settings.get(trx);
      const created = await this.sellers.insert(
        {
          userId,
          businessName: input.businessName,
          contactPhone: input.contactPhone,
          pickup: input.pickup,
          status: SellerStatus.PENDING_APPROVAL,
          commissionRate: defaultCommissionRate,
        },
        trx,
      );
      await this.history.insert(
        created.id,
        { fromStatus: null, toStatus: SellerStatus.PENDING_APPROVAL, reason: null, actorUserId: userId },
        trx,
      );
      return created;
    });
    this.logger.info('seller registered', {
      event: 'SELLER_REGISTERED',
      userId: seller.userId,
      sellerId: seller.id,
    });
    return { userId: seller.userId, sellerId: seller.id, email: input.email };
  }

  /** The profile behind the token. None (shouldn't happen for a seller token) → FORBIDDEN (spec 01 §6). */
  async requireByUserId(userId: string): Promise<Seller> {
    const seller = await this.sellers.findByUserId(userId);
    if (!seller) throw forbidden();
    return seller;
  }

  async getProfile(userId: string): Promise<SellerProfile> {
    const seller = await this.requireByUserId(userId);
    return { seller, email: await this.emailOf(userId) };
  }

  /** Any status; no re-approval needed (S-7). Affects new orders only (pickup is snapshotted). */
  async updateProfile(userId: string, patch: SellerProfilePatch): Promise<SellerProfile> {
    const { id } = await this.requireByUserId(userId);
    const seller = await this.sellers.updateProfile(id, patch);
    if (!seller) throw forbidden();
    return { seller, email: await this.emailOf(userId) };
  }

  /** `rejected → pending_approval` (Q-29). The rejection reason stays until the next decision. */
  async reapply(userId: string): Promise<SellerProfile> {
    const { id } = await this.requireByUserId(userId);
    const seller = await this.transactions.run(async (trx) => {
      const updated = await this.sellers.transitionStatus(
        id,
        SellerStatus.REJECTED,
        SellerStatus.PENDING_APPROVAL,
        trx,
      );
      if (!updated) throw sellerInvalidStatusTransition();
      await this.history.insert(
        id,
        {
          fromStatus: SellerStatus.REJECTED,
          toStatus: SellerStatus.PENDING_APPROVAL,
          reason: null,
          actorUserId: userId,
        },
        trx,
      );
      return updated;
    });
    this.logger.info('seller re-applied', { event: 'SELLER_REAPPLIED', sellerId: id, userId });
    return { seller, email: await this.emailOf(userId) };
  }

  private async emailOf(userId: string): Promise<string> {
    const [user] = await this.accounts.getUsersByIds([userId]);
    // sellers.user_id is a FK to users, so the user always exists.
    if (!user) throw new Error(`user ${userId} of a seller profile is missing`);
    return user.email;
  }
}

import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ISellerDirectory, SellerStatus, sellerNotApproved } from '../../sellers';

/** Resolves the seller behind a seller-role user (spec 06 UC-CA-3, S-17). */
@injectable()
export class SellerGuard {
  constructor(@inject(TOKENS.SellerDirectory) private readonly sellers: ISellerDirectory) {}

  /**
   * Every seller write: the seller must be approved. Read `FOR SHARE` inside the write
   * transaction, so a concurrent suspension waits for this write and its projection consumer then
   * sees the new rows (spec 06 CA-3, spec 05 SE-4).
   */
  async approvedSellerId(userId: string, trx: DbTransaction): Promise<string> {
    const seller = await this.sellers.getSellerByUserId(userId, { trx, lockShared: true });
    if (seller?.status !== SellerStatus.APPROVED) throw sellerNotApproved();
    return seller.sellerId;
  }

  /** Seller reads work in any status. A seller-role account always has a profile (spec 05 UC-SE-1). */
  async sellerId(userId: string): Promise<string> {
    const seller = await this.sellers.getSellerByUserId(userId);
    if (!seller) throw sellerNotApproved();
    return seller.sellerId;
  }
}

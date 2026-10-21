import { inject, injectable } from 'tsyringe';
import { type IAuditRecorder } from '../../../lib/audit';
import { type IClock } from '../../../lib/clock';
import { type ITransactionRunner } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IOutbox, ProductBlocked, ProductUnblocked } from '../../../lib/events';
import { ProductStatus } from '../enums';
import { productBlockInvalidStatus, productNotFound } from '../errors';
import { type ProductRepository } from '../repository/product.repository';
import { type ProductDetailCache } from './product-detail-cache.service';
import { type ProductDetail, type SellerProductService } from './seller-product.service';

/**
 * The admin product block (spec 20 §3.4, BO-6, BO-14…BO-16): a block takes the product off the shop
 * (an `active` product becomes `inactive`; activation is refused while blocked); an unblock clears the
 * block and leaves the status for the seller. Both lock the product, write an audit row and an event in
 * one transaction, and delete the product-detail cache after commit (CA-8).
 */
@injectable()
export class ProductBlockService {
  constructor(
    @inject(TOKENS.TransactionRunner) private readonly tx: ITransactionRunner,
    @inject(TOKENS.Outbox) private readonly outbox: IOutbox,
    @inject(TOKENS.Clock) private readonly clock: IClock,
    @inject(TOKENS.AuditRecorder) private readonly audit: IAuditRecorder,
    @inject(TOKENS.ProductRepository) private readonly products: ProductRepository,
    @inject(TOKENS.ProductDetailCache) private readonly detailCache: ProductDetailCache,
    @inject(TOKENS.SellerProductService) private readonly sellerProducts: SellerProductService,
  ) {}

  /** The audit actor comes from the request context (lib/audit). */
  block(productId: string, reason: string): Promise<void> {
    return this.change(productId, { reason, at: this.clock.now() });
  }

  unblock(productId: string): Promise<void> {
    return this.change(productId, null);
  }

  /** `GET /admin/products/:productId`: the seller's product detail, any status, deleted ones excluded. */
  async detail(productId: string): Promise<{ sellerId: string; detail: ProductDetail }> {
    const product = await this.products.findLiveByIdForRead(productId);
    if (!product) throw productNotFound();
    return {
      sellerId: product.sellerId,
      detail: await this.sellerProducts.detail(productId, product.sellerId),
    };
  }

  private async change(productId: string, block: { reason: string; at: Date } | null): Promise<void> {
    await this.tx.run(async (trx) => {
      const product = await this.products.findLiveById(productId, trx, { forUpdate: true });
      if (!product) throw productNotFound();
      const blocked = product.adminBlockedAt !== null;
      if (blocked === (block !== null)) throw productBlockInvalidStatus();
      await this.products.setAdminBlock(
        product.id,
        block,
        // BO-16: only an active product leaves the shop by changing status; a draft stays a draft.
        block && product.status === ProductStatus.ACTIVE ? ProductStatus.INACTIVE : null,
        trx,
      );
      const at = block?.at ?? this.clock.now();
      await this.outbox.add(trx, {
        contract: block ? ProductBlocked : ProductUnblocked,
        aggregateId: product.id,
        payload: { productId: product.id, sellerId: product.sellerId, at: at.toISOString() },
      });
      await this.audit.record(
        {
          action: block ? 'product.blocked' : 'product.unblocked',
          targetId: product.id,
          before: { adminBlocked: blocked },
          after: { adminBlocked: !blocked },
          reason: block?.reason ?? null,
        },
        trx,
      );
    });
    await this.detailCache.invalidate([productId]);
  }
}

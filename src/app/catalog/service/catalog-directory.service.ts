import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type PurchasableVariant } from '../model/purchasable-variant.model';
import { type ProductVariantRepository } from '../repository/product-variant.repository';

/** Public API of catalog (spec 06 §2). */
export interface ICatalogDirectory {
  /** One query. Unknown ids are left out; hidden or deleted ones come back with `purchasable: false`. */
  getVariantsForPurchase(variantIds: readonly string[], trx?: DbTransaction): Promise<PurchasableVariant[]>;
}

@injectable()
export class CatalogDirectory implements ICatalogDirectory {
  constructor(@inject(TOKENS.ProductVariantRepository) private readonly variants: ProductVariantRepository) {}

  getVariantsForPurchase(variantIds: readonly string[], trx?: DbTransaction): Promise<PurchasableVariant[]> {
    return this.variants.findForPurchase(variantIds, trx);
  }
}

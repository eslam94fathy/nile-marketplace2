import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type IInventoryService, type StockDto } from '../../inventory';
import { type ProductVariant, type VariantOptionValue } from '../model/product-variant.model';
import { type VariantAttributeValueRepository } from '../repository/variant-attribute-value.repository';

export interface VariantView {
  variant: ProductVariant;
  options: VariantOptionValue[];
  stock: StockDto;
}

/** Variants with their options and stock: two batched lookups, never one per variant (G20). */
@injectable()
export class VariantViewService {
  constructor(
    @inject(TOKENS.VariantAttributeValueRepository)
    private readonly values: VariantAttributeValueRepository,
    @inject(TOKENS.InventoryService) private readonly inventory: IInventoryService,
  ) {}

  async build(variants: readonly ProductVariant[], trx?: DbTransaction): Promise<VariantView[]> {
    const ids = variants.map((variant) => variant.id);
    const options = await this.values.findByVariantIds(ids, trx);
    const stock = new Map((await this.inventory.getStockByVariantIds(ids, trx)).map((s) => [s.variantId, s]));
    return variants.map((variant) => ({
      variant,
      options: options.get(variant.id) ?? [],
      // Every variant gets its stock row in its create transaction; a gap here is a bug.
      stock: stock.get(variant.id) ?? missingStock(variant.id),
    }));
  }
}

function missingStock(variantId: string): never {
  throw new Error(`variant ${variantId} has no inventory item`);
}

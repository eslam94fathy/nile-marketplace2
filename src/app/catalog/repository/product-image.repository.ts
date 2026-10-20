import { inject, injectable } from 'tsyringe';
import { type DbExecutor, type DbTransaction, type IDatabase } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { CATALOG_TABLES } from '../constants';
import { type ProductImage } from '../model/product-image.model';

const T = CATALOG_TABLES.PRODUCT_IMAGES;
const COLUMNS = ['id', 'product_id', 'media_id', 'variant_id', 'position', 'alt_text'] as const;

interface ProductImageTable {
  id: string;
  product_id: string;
  media_id: string;
  variant_id: string | null;
  position: number;
  alt_text: string | null;
  created_at: Date;
  updated_at: Date;
}

type ProductImageRow = Pick<ProductImageTable, (typeof COLUMNS)[number]>;

export type ProductImagePatch = Partial<Pick<ProductImage, 'variantId' | 'altText'>>;

function toModel(row: ProductImageRow): ProductImage {
  return {
    id: row.id,
    productId: row.product_id,
    mediaId: row.media_id,
    variantId: row.variant_id,
    position: row.position,
    altText: row.alt_text,
  };
}

/**
 * All SQL of `product_images` (spec 06 §8). Writes run under the product's row lock, so positions are
 * changed by one statement each; `uq_product_images_product_id_position` is deferrable and checked at
 * the end of the statement.
 */
@injectable()
export class ProductImageRepository {
  constructor(@inject(TOKENS.Database) private readonly db: IDatabase) {}

  private exec(trx?: DbTransaction): DbExecutor {
    return trx ?? this.db.knex;
  }

  /** In position order (uq_product_images_product_id_position). */
  async findByProduct(productId: string, trx?: DbTransaction): Promise<ProductImage[]> {
    const rows = await this.exec(trx)<ProductImageTable>(T)
      .select(...COLUMNS)
      .where({ product_id: productId })
      .orderBy('position');
    return rows.map(toModel);
  }

  /** The image at position 0 of each product, in one query (spec 06 §8.5). */
  async findPrimaryByProductIds(productIds: readonly string[]): Promise<ProductImage[]> {
    if (productIds.length === 0) return [];
    const rows = await this.db
      .knex<ProductImageTable>(T)
      .select(...COLUMNS)
      .whereIn('product_id', [...new Set(productIds)])
      .andWhere({ position: 0 });
    return rows.map(toModel);
  }

  /** Inserts at `position`, shifting the later images up by one first. */
  async insertAt(image: Omit<ProductImage, 'id'>, trx: DbTransaction): Promise<void> {
    await trx(T)
      .where({ product_id: image.productId })
      .andWhere('position', '>=', image.position)
      .update({ position: trx.raw('position + 1'), updated_at: trx.fn.now() });
    await trx<ProductImageTable>(T).insert({
      product_id: image.productId,
      media_id: image.mediaId,
      variant_id: image.variantId,
      position: image.position,
      alt_text: image.altText,
    });
  }

  async update(id: string, patch: ProductImagePatch, trx: DbTransaction): Promise<void> {
    await trx<ProductImageTable>(T)
      .where({ id })
      .update({
        ...(patch.variantId !== undefined && { variant_id: patch.variantId }),
        ...(patch.altText !== undefined && { alt_text: patch.altText }),
        updated_at: trx.fn.now(),
      });
  }

  /** Positions 0..n-1 in the order of `mediaIds`, in one statement. */
  async reorder(productId: string, mediaIds: readonly string[], trx: DbTransaction): Promise<void> {
    if (mediaIds.length === 0) return;
    const values = mediaIds.map(() => '(?::uuid, ?::smallint)').join(', ');
    await trx.raw(
      `UPDATE ${T} AS i SET position = v.position, updated_at = now()
         FROM (VALUES ${values}) AS v (media_id, position)
        WHERE i.product_id = ? AND i.media_id = v.media_id`,
      [...mediaIds.flatMap((mediaId, position) => [mediaId, position]), productId],
    );
  }

  /** Deletes the image and closes the gap behind it. */
  async deleteAndCompact(image: ProductImage, trx: DbTransaction): Promise<void> {
    await trx(T).where({ id: image.id }).del();
    await trx(T)
      .where({ product_id: image.productId })
      .andWhere('position', '>', image.position)
      .update({ position: trx.raw('position - 1'), updated_at: trx.fn.now() });
  }

  /** A soft-deleted variant's images stay on the product, untied (spec 06 UC-CA-8). */
  async untieVariant(variantId: string, trx: DbTransaction): Promise<void> {
    await trx(T).where({ variant_id: variantId }).update({ variant_id: null, updated_at: trx.fn.now() });
  }
}

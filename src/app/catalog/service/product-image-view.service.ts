import { inject, injectable } from 'tsyringe';
import { type DbTransaction } from '../../../lib/db';
import { TOKENS } from '../../../lib/di';
import { type ImageView, type MediaService } from '../../media';
import { type ProductImage, type ProductImageView } from '../model/product-image.model';
import { type ProductImageRepository } from '../repository/product-image.repository';

/** Product images with their URLs: one image read and one media read per call (no N+1, G20). */
@injectable()
export class ProductImageViewService {
  constructor(
    @inject(TOKENS.ProductImageRepository) private readonly images: ProductImageRepository,
    @inject(TOKENS.MediaService) private readonly media: MediaService,
  ) {}

  /** Every image of a product, in position order. */
  async forProduct(productId: string, trx?: DbTransaction): Promise<ProductImageView[]> {
    return this.views(await this.images.findByProduct(productId, trx));
  }

  /** The primary image of each product that has one (a list page, spec 06 §8.5). */
  async primaryFor(productIds: readonly string[]): Promise<Map<string, ImageView>> {
    const primaries = await this.images.findPrimaryByProductIds(productIds);
    const views = await this.media.getImages(primaries.map((image) => image.mediaId));
    return new Map(
      primaries.flatMap((primary) => {
        const view = views.get(primary.mediaId);
        return view ? [[primary.productId, view] as const] : [];
      }),
    );
  }

  /** Attached media is always ready, so every row has an image. */
  private async views(rows: readonly ProductImage[]): Promise<ProductImageView[]> {
    const views = await this.media.getImages(rows.map((row) => row.mediaId));
    return rows.flatMap((row) => {
      const image = views.get(row.mediaId);
      return image ? [{ image, position: row.position, variantId: row.variantId, altText: row.altText }] : [];
    });
  }
}

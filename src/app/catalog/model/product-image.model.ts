import { type ImageView } from '../../media';

/** One row of `product_images` (spec 06 §8.1). Clients name an image by its `mediaId`. */
export interface ProductImage {
  id: string;
  productId: string;
  mediaId: string;
  /** Tied to one variant, or `null` for the product as a whole. */
  variantId: string | null;
  /** 0-based; 0 is the primary image. */
  position: number;
  altText: string | null;
}

/** A product image with its URLs. */
export interface ProductImageView {
  image: ImageView;
  position: number;
  variantId: string | null;
  altText: string | null;
}

/**
 * The image shown for a variant: its lowest-position tied image, else the primary image
 * (spec 06 §8.1). `images` are in position order.
 */
export function variantImageId(images: readonly ProductImageView[], variantId: string): string | null {
  const tied = images.find((view) => view.variantId === variantId);
  return (tied ?? images[0])?.image.id ?? null;
}

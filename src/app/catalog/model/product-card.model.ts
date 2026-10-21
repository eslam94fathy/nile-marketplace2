import { type ImageView } from '../../media';

/** A product as other modules show it (spec 06 §9.3): money as 2-decimal strings, no internals. */
export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  minPrice: string | null;
  maxPrice: string | null;
  inStock: boolean;
  /** VIS right now (02-database.md §5). */
  available: boolean;
  primaryImage: ImageView | null;
  rating: { avg: string | null; count: number };
}

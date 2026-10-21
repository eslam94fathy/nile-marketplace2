export const REVIEW_TABLES = {
  PRODUCT_REVIEWS: 'product_reviews',
  REVIEW_IMAGES: 'review_images',
  REVIEW_REPLIES: 'review_replies',
  RATING_STATS: 'review_rating_stats',
} as const;

/** Spec 17 §1 limits (constants; the windows are env). */
export const REVIEW_LIMITS = {
  RATING_MIN: 1,
  RATING_MAX: 5,
  TITLE_MAX: 120,
  BODY_MAX: 2000,
  MAX_IMAGES: 4,
  REPLY_MAX: 1000,
  HIDE_REASON_MIN: 3,
  HIDE_REASON_MAX: 500,
} as const;

/** The rating values, in order: one `count_<n>` column each. */
export const RATINGS = [1, 2, 3, 4, 5] as const;
export type Rating = (typeof RATINGS)[number];

/** Paths under /api/v1 (spec 17 §4.2). */
export const MY_REVIEW_PATHS = {
  REVIEWS: '/reviews',
  MY_REVIEWS: '/me/reviews',
  MY_REVIEW: '/me/reviews/:reviewId',
  REVIEWABLE_ITEMS: '/me/reviewable-items',
} as const;

/** Paths under /api/v1 (spec 17 §4.1, §4.3, §4.4). */
export const REVIEW_PATHS = {
  PRODUCT_REVIEWS: '/products/:productId/reviews',
  PRODUCT_SUMMARY: '/products/:productId/reviews/summary',
  SELLER_REVIEWS: '/seller/reviews',
  SELLER_REPLY: '/seller/reviews/:reviewId/reply',
  ADMIN_REVIEWS: '/admin/reviews',
  ADMIN_REVIEW: '/admin/reviews/:reviewId',
  ADMIN_HIDE: '/admin/reviews/:reviewId/hide',
  ADMIN_UNHIDE: '/admin/reviews/:reviewId/unhide',
  ADMIN_REPLY_HIDE: '/admin/reviews/:reviewId/reply/hide',
  ADMIN_REPLY_UNHIDE: '/admin/reviews/:reviewId/reply/unhide',
} as const;

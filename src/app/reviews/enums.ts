/** Spec 17 §1. Published at once; an admin may hide it (post-moderation, R-10). */
export const ReviewStatus = {
  PUBLISHED: 'published',
  HIDDEN: 'hidden',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

/** The two aggregates every counted review moves (spec 17 §1.2). */
export const RatingSubjectType = {
  PRODUCT: 'product',
  SELLER: 'seller',
} as const;
export type RatingSubjectType = (typeof RatingSubjectType)[keyof typeof RatingSubjectType];

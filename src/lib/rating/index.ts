import DecimalBase from 'decimal.js';

const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });

/** Places of a rating average ("4.30"): `NUMERIC(3,2)` on products and sellers (spec 06 §9.1). */
export const RATING_AVG_SCALE = 2;

/**
 * The rating average rule of spec 17 §1.2, shared by every copy so they round the same way:
 * `round(sum / count, 2)` with ROUND_HALF_UP, as a 2-decimal string; `null` without ratings.
 */
export function ratingAverage(ratingSum: number, ratingCount: number): string | null {
  if (ratingCount === 0) return null;
  return new Decimal(ratingSum)
    .dividedBy(ratingCount)
    .toDecimalPlaces(RATING_AVG_SCALE, Decimal.ROUND_HALF_UP)
    .toFixed(RATING_AVG_SCALE);
}

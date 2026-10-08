import DecimalBase from 'decimal.js';

/** Private Decimal constructor: never mutate the global decimal.js config. */
const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
type Decimal = InstanceType<typeof Decimal>;

/** Single currency for now (CLAUDE.md §6.2). Kept explicit so multi-currency can be added later. */
export const EGP = 'EGP' as const;
export type Currency = typeof EGP;

const MONEY_SCALE = 2;
const RATE_SCALE = 4;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

function parseDecimal(value: string, what: string): Decimal {
  if (!DECIMAL_STRING.test(value)) throw new RangeError(`${what} must be a decimal string, got "${value}"`);
  return new Decimal(value);
}

/** A rate between 0 and 1 with up to 4 decimals, e.g. a commission of "0.1000" (NUMERIC(5,4)). */
export class Rate {
  private constructor(private readonly value: Decimal) {}

  static of(value: string): Rate {
    const decimal = parseDecimal(value, 'Rate');
    if (decimal.lt(0) || decimal.gt(1)) throw new RangeError(`Rate must be between 0 and 1, got "${value}"`);
    if (decimal.decimalPlaces() > RATE_SCALE)
      throw new RangeError(`Rate has more than ${RATE_SCALE} decimals`);
    return new Rate(decimal);
  }

  /** @internal used by Money */
  toDecimal(): Decimal {
    return this.value;
  }

  toString(): string {
    return this.value.toFixed(RATE_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}

/**
 * EGP amount with exactly 2 decimals. All money math goes through this type, never `number`.
 * Every operation returns a new Money; multiplication rounds ROUND_HALF_UP to the piastre.
 */
export class Money {
  readonly currency: Currency = EGP;

  private constructor(private readonly amount: Decimal) {}

  /** From a DB / API decimal string. More than 2 decimals is rejected, never silently rounded. */
  static of(value: string): Money {
    const decimal = parseDecimal(value, 'Money');
    if (decimal.decimalPlaces() > MONEY_SCALE) {
      throw new RangeError(`Money has more than ${MONEY_SCALE} decimals: "${value}"`);
    }
    return new Money(decimal);
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  static sum(values: readonly Money[]): Money {
    return values.reduce((total, value) => total.plus(value), Money.zero());
  }

  plus(other: Money): Money {
    return new Money(this.amount.plus(other.amount));
  }

  minus(other: Money): Money {
    return new Money(this.amount.minus(other.amount));
  }

  /** Multiply by an integer quantity (exact). */
  timesQuantity(quantity: number): Money {
    if (!Number.isSafeInteger(quantity)) throw new RangeError(`Quantity must be an integer, got ${quantity}`);
    return new Money(this.amount.times(quantity));
  }

  /** Multiply by a rate, rounded half-up to the piastre (e.g. commission = round(subtotal × rate)). */
  timesRate(rate: Rate): Money {
    return new Money(this.amount.times(rate.toDecimal()).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP));
  }

  /**
   * Splits into `parts` equal shares rounded DOWN to the piastre, plus the leftover piastres
   * (docs/spec/09-ordering.md §3.8: `base × parts + remainder = this`).
   */
  splitEvenly(parts: number): { base: Money; remainder: Money } {
    if (!Number.isSafeInteger(parts) || parts < 1)
      throw new RangeError(`parts must be a positive integer, got ${parts}`);
    if (this.isNegative()) throw new RangeError('Cannot split a negative amount');
    const base = this.amount.dividedBy(parts).toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_DOWN);
    return { base: new Money(base), remainder: new Money(this.amount.minus(base.times(parts))) };
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  equals(other: Money): boolean {
    return this.amount.eq(other.amount);
  }

  greaterThan(other: Money): boolean {
    return this.amount.gt(other.amount);
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.amount.gte(other.amount);
  }

  lessThan(other: Money): boolean {
    return this.amount.lt(other.amount);
  }

  /** Always 2 decimals, e.g. "150.00": the API and DB representation. */
  toString(): string {
    return this.amount.toFixed(MONEY_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }
}

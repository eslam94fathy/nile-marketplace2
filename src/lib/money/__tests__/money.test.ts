import { describe, expect, it } from 'vitest';
import { EGP, Money, Rate } from '..';

const m = (value: string) => Money.of(value);

describe('lib/money Money', () => {
  it('parses decimal strings and always serialises 2 decimals', () => {
    expect(m('150').toString()).toBe('150.00');
    expect(m('0.5').toString()).toBe('0.50');
    expect(JSON.stringify({ total: m('9.99') })).toBe('{"total":"9.99"}');
    expect(m('1').currency).toBe(EGP);
  });

  it('rejects non-decimal input and more than 2 decimals (no silent rounding)', () => {
    for (const bad of ['', 'abc', '1e3', '1.234', ' 1.00', 'NaN']) {
      expect(() => m(bad)).toThrow(RangeError);
    }
  });

  it('adds and subtracts exactly (no float drift)', () => {
    expect(m('0.10').plus(m('0.20')).toString()).toBe('0.30');
    expect(m('100.00').minus(m('99.99')).toString()).toBe('0.01');
    expect(Money.sum([m('19.99'), m('0.01'), m('80.00')]).toString()).toBe('100.00');
    expect(Money.sum([]).toString()).toBe('0.00');
  });

  it('multiplies by integer quantities', () => {
    expect(m('33.33').timesQuantity(3).toString()).toBe('99.99');
    expect(() => m('1.00').timesQuantity(1.5)).toThrow(RangeError);
  });

  it('applies rates with ROUND_HALF_UP (commission = round(subtotal × rate))', () => {
    expect(m('100.05').timesRate(Rate.of('0.1')).toString()).toBe('10.01'); // 10.005 → 10.01
    expect(m('100.04').timesRate(Rate.of('0.1000')).toString()).toBe('10.00'); // 10.004 → 10.00
    expect(m('60.00').timesRate(Rate.of('0.7')).toString()).toBe('42.00');
    expect(m('99.99').timesRate(Rate.of('0.1250')).toString()).toBe('12.50'); // 12.49875 → 12.50
  });

  it('splits evenly with the remainder kept separately (agent fee share, spec 09 §3.8)', () => {
    expect(m('42.00').splitEvenly(3)).toEqual({ base: m('14.00'), remainder: m('0.00') });
    const split = m('43.00').splitEvenly(3);
    expect(split.base.toString()).toBe('14.33');
    expect(split.remainder.toString()).toBe('0.01');
    expect(split.base.timesQuantity(3).plus(split.remainder).equals(m('43.00'))).toBe(true);
    expect(() => m('1.00').splitEvenly(0)).toThrow(RangeError);
  });

  it('allocates in proportion with largest-remainder rounding (coupon shares, spec 19 §1.2)', () => {
    const strings = (shares: Money[]) => shares.map((share) => share.toString());
    expect(strings(m('10.00').allocate([m('100.00'), m('100.00'), m('100.00')]))).toEqual([
      '3.34',
      '3.33',
      '3.33',
    ]);
    // Exact shares 1.428…, 2.857…, 5.714…: floors 1.42, 2.85, 5.71; the 2 leftover piastres go to the
    // largest remainders (0.857… and 0.714…).
    expect(strings(m('10.00').allocate([m('25.00'), m('50.00'), m('100.00')]))).toEqual([
      '1.43',
      '2.86',
      '5.71',
    ]);
    expect(strings(m('30.00').allocate([m('10.00'), m('20.00')]))).toEqual(['10.00', '20.00']);
    expect(strings(m('0.00').allocate([m('5.00')]))).toEqual(['0.00']);
    expect(strings(Money.zero().allocate([Money.zero()]))).toEqual(['0.00']);
    expect(() => m('1.00').allocate([Money.zero()])).toThrow(RangeError);
    expect(() => m('1.00').allocate([m('1.00').minus(m('2.00'))])).toThrow(RangeError);
  });

  it('allocation always adds up and never exceeds a weight (random carts)', () => {
    let seed = 7;
    const random = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let run = 0; run < 500; run += 1) {
      const weights = Array.from({ length: 1 + random(8) }, () =>
        m(`${1 + random(5000)}.${String(random(100)).padStart(2, '0')}`),
      );
      const total = Money.sum(weights);
      const amount = m(
        `${random(Number(total.toString().split('.')[0]) + 1)}.${String(random(100)).padStart(2, '0')}`,
      );
      const target = amount.greaterThan(total) ? total : amount;
      const shares = target.allocate(weights);
      expect(Money.sum(shares).equals(target)).toBe(true);
      shares.forEach((share, i) => {
        expect(share.isNegative()).toBe(false);
        expect(share.greaterThan(weights[i] ?? Money.zero())).toBe(false);
      });
    }
  });

  it('multiplies by a ratio, rounded half-up (kept coupon shares, spec 09 §8.7)', () => {
    expect(m('10.00').timesRatio(1, 3).toString()).toBe('3.33');
    expect(m('10.00').timesRatio(2, 3).toString()).toBe('6.67');
    expect(m('0.05').timesRatio(1, 2).toString()).toBe('0.03'); // 0.025 → 0.03
    expect(m('7.00').timesRatio(0, 4).toString()).toBe('0.00');
    expect(() => m('1.00').timesRatio(1, 0)).toThrow(RangeError);
  });

  it('compares values', () => {
    expect(m('1.00').equals(m('1'))).toBe(true);
    expect(m('2.00').greaterThan(m('1.99'))).toBe(true);
    expect(m('1.00').greaterThanOrEqual(m('1.00'))).toBe(true);
    expect(m('1.00').lessThan(m('1.01'))).toBe(true);
    expect(Money.zero().isZero()).toBe(true);
    expect(m('1.00').minus(m('2.00')).isNegative()).toBe(true);
    expect(Money.zero().isNegative()).toBe(false);
  });
});

describe('lib/money Rate', () => {
  it('accepts 0..1 with up to 4 decimals', () => {
    expect(Rate.of('0.1').toString()).toBe('0.1000');
    expect(Rate.of('1').toString()).toBe('1.0000');
    expect(JSON.stringify(Rate.of('0.7'))).toBe('"0.7000"');
  });

  it('rejects out-of-range or over-precise rates', () => {
    for (const bad of ['-0.1', '1.0001', '0.12345', 'x']) expect(() => Rate.of(bad)).toThrow(RangeError);
  });
});

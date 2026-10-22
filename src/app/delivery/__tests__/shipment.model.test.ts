import { describe, expect, it } from 'vitest';
import { Money } from '../../../lib/money';
import { AttemptFailureReason, ShipmentKind, ShipmentStatus } from '../enums';
import { DeliveryErrorCode } from '../errors';
import {
  afterFailedAttempt,
  amountToCollect,
  collectedAmountFor,
  deliveryFeeLeftUncollected,
  type Shipment,
  takesDeliveryFee,
} from '../model/shipment.model';

const R = AttemptFailureReason;
const S = ShipmentStatus;

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: 's1',
    kind: ShipmentKind.DELIVERY,
    returnId: null,
    sellerOrderId: 'so1',
    orderId: 'o1',
    agentId: 'a1',
    status: S.OUT_FOR_DELIVERY,
    orderNumber: 'NM-000000001',
    paymentMethod: 'cod',
    orderDeliveryFee: Money.of('50.00'),
    pickup: {
      businessName: 'Shop',
      phone: '+201221234567',
      governorateId: 'g',
      city: 'Cairo',
      area: 'Nasr City',
      street: 'Street',
      building: '5',
      landmark: null,
    },
    dropoff: {
      recipientName: 'Mona Ali',
      recipientPhone: '+201001234567',
      governorateId: 'g',
      governorateName: 'Cairo',
      city: 'Cairo',
      area: 'Maadi',
      street: 'Road 9',
      building: '12',
      floor: null,
      apartment: null,
      landmark: null,
    },
    codItemsAmount: Money.of('100.00'),
    carriesDeliveryFee: false,
    codFeeAmount: Money.zero(),
    codCollectedAmount: null,
    attemptCount: 0,
    assignedAt: null,
    pickedUpAt: null,
    deliveredAt: null,
    returnedAt: null,
    sellerOrderCancelledAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const carrier = (overrides: Partial<Shipment> = {}) =>
  shipment({ carriesDeliveryFee: true, codFeeAmount: Money.of('50.00'), ...overrides });

const kashier = (overrides: Partial<Shipment> = {}) =>
  shipment({
    paymentMethod: 'kashier',
    orderDeliveryFee: Money.zero(),
    codItemsAmount: Money.zero(),
    ...overrides,
  });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('shipment rules (spec 11 UC-DE-3, DE-8)', () => {
  describe('fee carrier', () => {
    it('the first COD shipment of the checkout going out takes the fee', () => {
      const me = shipment({ id: 's1', status: S.PICKED_UP });
      expect(takesDeliveryFee(me, [me, shipment({ id: 's2', status: S.ASSIGNED })])).toBe(true);
    });

    it('not while a sibling carries it, delivered or still out', () => {
      const me = shipment({ id: 's1', status: S.PICKED_UP });
      expect(takesDeliveryFee(me, [me, carrier({ id: 's2' })])).toBe(false);
      expect(takesDeliveryFee(me, [me, carrier({ id: 's2', status: S.DELIVERED })])).toBe(false);
    });

    it('again after the carrier released it on a failure', () => {
      const me = shipment({ id: 's1', status: S.DELIVERY_FAILED, attemptCount: 1 });
      expect(takesDeliveryFee(me, [me, shipment({ id: 's2', status: S.DELIVERY_FAILED })])).toBe(true);
    });

    it('never for a Kashier shipment', () => {
      const me = kashier({ status: S.PICKED_UP });
      expect(takesDeliveryFee(me, [me])).toBe(false);
    });
  });

  describe('amount to collect', () => {
    it('COD: items plus the fee only on the carrier; Kashier: nothing', () => {
      expect(amountToCollect(shipment()).toString()).toBe('100.00');
      expect(amountToCollect(carrier()).toString()).toBe('150.00');
      expect(amountToCollect(kashier()).toString()).toBe('0.00');
    });
  });

  describe('collected amount on delivery', () => {
    it('COD must collect exactly the amount to collect', () => {
      expect(collectedAmountFor(carrier(), Money.of('150'))?.toString()).toBe('150.00');
      expect(codeOf(() => collectedAmountFor(carrier(), Money.of('100.00')))).toBe(
        DeliveryErrorCode.COD_AMOUNT_MISMATCH,
      );
      expect(codeOf(() => collectedAmountFor(shipment(), undefined))).toBe(
        DeliveryErrorCode.COD_AMOUNT_REQUIRED,
      );
    });

    it('Kashier collects nothing and takes no amount, not even 0.00', () => {
      expect(collectedAmountFor(kashier(), undefined)).toBeNull();
      expect(codeOf(() => collectedAmountFor(kashier(), Money.zero()))).toBe(
        DeliveryErrorCode.COD_AMOUNT_NOT_ALLOWED,
      );
    });
  });

  describe('failed attempts', () => {
    it('the 1st and 2nd attempts may go out again; the 3rd goes back to the seller', () => {
      expect(afterFailedAttempt(0, R.CUSTOMER_UNREACHABLE)).toEqual({ attemptNumber: 1, returning: false });
      expect(afterFailedAttempt(1, R.WRONG_ADDRESS)).toEqual({ attemptNumber: 2, returning: false });
      expect(afterFailedAttempt(2, R.CUSTOMER_RESCHEDULED)).toEqual({ attemptNumber: 3, returning: true });
    });

    it('a refusal goes back at once', () => {
      expect(afterFailedAttempt(0, R.CUSTOMER_REFUSED)).toEqual({ attemptNumber: 1, returning: true });
    });

    it('there is no 4th attempt', () => {
      expect(() => afterFailedAttempt(3, R.CUSTOMER_UNREACHABLE)).toThrow();
    });
  });

  describe('uncollected fee (S-3)', () => {
    it('a delivery without the fee and nothing left that can go out', () => {
      const delivered = shipment({ id: 's1', status: S.DELIVERED });
      const back = shipment({ id: 's2', status: S.RETURNING_TO_SELLER });
      expect(deliveryFeeLeftUncollected([delivered, back])).toBe(true);
    });

    it('not while a sibling may still go out, or the fee was collected, or nothing was delivered', () => {
      const delivered = shipment({ id: 's1', status: S.DELIVERED });
      expect(deliveryFeeLeftUncollected([delivered, shipment({ id: 's2', status: S.DELIVERY_FAILED })])).toBe(
        false,
      );
      expect(deliveryFeeLeftUncollected([carrier({ status: S.DELIVERED })])).toBe(false);
      expect(deliveryFeeLeftUncollected([shipment({ status: S.RETURNING_TO_SELLER })])).toBe(false);
    });

    it('never for Kashier or a free delivery', () => {
      expect(deliveryFeeLeftUncollected([kashier({ status: S.DELIVERED })])).toBe(false);
      expect(
        deliveryFeeLeftUncollected([shipment({ status: S.DELIVERED, orderDeliveryFee: Money.zero() })]),
      ).toBe(false);
    });
  });
});

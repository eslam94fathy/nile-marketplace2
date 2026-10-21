import { describe, expect, it } from 'vitest';
import { TicketCategory, TicketOpenerRole, TicketStatus } from '../enums';
import { type SupportTicket } from '../model/support-ticket.model';
import { afterAdminMessage, afterUserMessage } from '../service/ticket-transitions';

const EARLIER = new Date('2026-10-20T08:00:00.000Z');
const AT = new Date('2026-10-21T10:00:00.000Z');

function ticket(overrides: Partial<SupportTicket>): SupportTicket {
  return {
    id: 'ticket',
    ticketNumber: 'T-000000001',
    openerUserId: 'opener',
    openerRole: TicketOpenerRole.CUSTOMER,
    category: TicketCategory.OTHER,
    subject: 'Where is it?',
    status: TicketStatus.OPEN,
    orderId: null,
    sellerOrderId: null,
    assignedAdminUserId: null,
    lastMessageAt: EARLIER,
    lastUserMessageAt: EARLIER,
    lastAdminMessageAt: null,
    awaitingAdminSince: EARLIER,
    slaBreachedAt: null,
    resolvedAt: null,
    closedAt: null,
    createdAt: EARLIER,
    ...overrides,
  };
}

describe('ticket transitions (spec 16 §1.1, SU-11, SU-12)', () => {
  describe('a user message', () => {
    it.each([TicketStatus.OPEN, TicketStatus.AWAITING_ADMIN])(
      'on %s keeps the status and the current wait, SLA flag included',
      (status) => {
        const result = afterUserMessage(ticket({ status, slaBreachedAt: EARLIER }), AT);
        expect(result).toEqual({
          patch: { lastMessageAt: AT, lastUserMessageAt: AT },
          movedTo: null,
          reopened: false,
        });
      },
    );

    it('on awaiting_user starts a new wait: awaiting_admin, the old SLA flag cleared', () => {
      const result = afterUserMessage(
        ticket({ status: TicketStatus.AWAITING_USER, awaitingAdminSince: null, slaBreachedAt: EARLIER }),
        AT,
      );
      expect(result).toEqual({
        patch: {
          lastMessageAt: AT,
          lastUserMessageAt: AT,
          status: TicketStatus.AWAITING_ADMIN,
          awaitingAdminSince: AT,
          slaBreachedAt: null,
          resolvedAt: null,
        },
        movedTo: TicketStatus.AWAITING_ADMIN,
        reopened: false,
      });
    });

    it('on resolved reopens it into awaiting_admin and clears resolved_at', () => {
      const result = afterUserMessage(
        ticket({ status: TicketStatus.RESOLVED, awaitingAdminSince: null, resolvedAt: EARLIER }),
        AT,
      );
      expect(result.movedTo).toBe(TicketStatus.AWAITING_ADMIN);
      expect(result.reopened).toBe(true);
      expect(result.patch).toMatchObject({ resolvedAt: null, awaitingAdminSince: AT, slaBreachedAt: null });
    });
  });

  describe('an admin message', () => {
    it.each([TicketStatus.OPEN, TicketStatus.AWAITING_ADMIN])(
      'on %s ends the wait: awaiting_user, the SLA flag kept as history',
      (status) => {
        const result = afterAdminMessage(ticket({ status, slaBreachedAt: EARLIER }), AT);
        expect(result).toEqual({
          patch: {
            lastMessageAt: AT,
            lastAdminMessageAt: AT,
            status: TicketStatus.AWAITING_USER,
            awaitingAdminSince: null,
            resolvedAt: null,
          },
          movedTo: TicketStatus.AWAITING_USER,
          reopened: false,
        });
        expect(result.patch).not.toHaveProperty('slaBreachedAt');
      },
    );

    it('on awaiting_user only updates the bookkeeping', () => {
      const result = afterAdminMessage(
        ticket({ status: TicketStatus.AWAITING_USER, awaitingAdminSince: null }),
        AT,
      );
      expect(result).toEqual({
        patch: { lastMessageAt: AT, lastAdminMessageAt: AT },
        movedTo: null,
        reopened: false,
      });
    });

    it('on resolved reopens it into awaiting_user', () => {
      const result = afterAdminMessage(
        ticket({ status: TicketStatus.RESOLVED, awaitingAdminSince: null, resolvedAt: EARLIER }),
        AT,
      );
      expect(result.movedTo).toBe(TicketStatus.AWAITING_USER);
      expect(result.reopened).toBe(true);
      expect(result.patch.resolvedAt).toBeNull();
    });
  });
});

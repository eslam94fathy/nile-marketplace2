import { describe, expect, it, vi } from 'vitest';
import { runWithContext } from '../../../lib/context';
import { type DbTransaction } from '../../../lib/db';
import { type ILogger } from '../../../lib/logger';
import { type NewAuditLogEntry } from '../model/audit-log-entry.model';
import { type AuditLogRepository } from '../repository/audit-log.repository';
import { AuditRecorderService } from '../service/audit-recorder.service';

const TRX = { isTransaction: true } as unknown as DbTransaction;
const CORRELATION_ID = '0192f5e0-0000-7000-8000-00000000c0de';
const ADMIN_ID = '0192f5e0-0000-7000-8000-0000000000ad';

function setup() {
  const inserted: NewAuditLogEntry[] = [];
  const log = {
    insert: vi.fn((entry: NewAuditLogEntry) => Promise.resolve(void inserted.push(entry))),
  } as unknown as AuditLogRepository;
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() };
  const recorder = new AuditRecorderService(log, { ...logger, child: () => logger } as unknown as ILogger);
  return { recorder, inserted, logger };
}

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithContext({ correlationId: CORRELATION_ID, userId: ADMIN_ID, ip: '203.0.113.7' }, fn);

/* Spec 20 §2.2: the actor comes from the context, only allow-listed fields, only changed fields. */
describe('AuditRecorderService', () => {
  it('records the admin, IP and correlation id of the request, and the target type of the action', async () => {
    const { recorder, inserted } = setup();
    await asAdmin(() =>
      recorder.record(
        {
          action: 'seller.suspended',
          targetId: 's-1',
          before: { status: 'approved' },
          after: { status: 'suspended' },
          reason: 'fraud',
        },
        TRX,
      ),
    );
    expect(inserted).toEqual([
      {
        actorType: 'admin',
        actorUserId: ADMIN_ID,
        action: 'seller.suspended',
        targetType: 'seller',
        targetId: 's-1',
        changes: { before: { status: 'approved' }, after: { status: 'suspended' } },
        reason: 'fraud',
        correlationId: CORRELATION_ID,
        ip: '203.0.113.7',
      },
    ]);
  });

  it('an update keeps only the fields that changed; no change at all → changes null', async () => {
    const { recorder, inserted } = setup();
    await asAdmin(async () => {
      await recorder.record(
        {
          action: 'category.updated',
          targetId: 'c-1',
          before: { name: 'Shoes', slug: 'shoes', sortOrder: 1, isActive: true, parentId: null },
          after: { name: 'Shoes', slug: 'shoes', sortOrder: 2, isActive: false, parentId: null },
        },
        TRX,
      );
      await recorder.record(
        { action: 'category.updated', targetId: 'c-1', before: { name: 'A' }, after: { name: 'A' } },
        TRX,
      );
    });
    expect(inserted[0]?.changes).toEqual({
      before: { sortOrder: 1, isActive: true },
      after: { sortOrder: 2, isActive: false },
    });
    expect(inserted[1]?.changes).toBeNull();
  });

  it('a create has only `after`, a delete only `before`, an entry without values has no changes', async () => {
    const { recorder, inserted } = setup();
    await asAdmin(async () => {
      await recorder.record(
        { action: 'admin.invited', targetId: 'u-1', after: { email: 'a@b.c', role: 'admin' } },
        TRX,
      );
      await recorder.record({ action: 'option.deleted', targetId: 'o-1', before: { value: 'XL' } }, TRX);
      await recorder.record({ action: 'user.invite_resent', targetId: 'u-1' }, TRX);
    });
    expect(inserted.map((entry) => entry.changes)).toEqual([
      { before: {}, after: { email: 'a@b.c', role: 'admin' } },
      { before: { value: 'XL' }, after: {} },
      null,
    ]);
  });

  it('drops a field outside the allow-list and warns with its name, never its value', async () => {
    const { recorder, inserted, logger } = setup();
    await asAdmin(() =>
      recorder.record(
        {
          action: 'admin.invited',
          targetId: 'u-1',
          after: { email: 'a@b.c', role: 'admin', inviteToken: 'secret-token' },
        },
        TRX,
      ),
    );
    expect(inserted[0]?.changes).toEqual({ before: {}, after: { email: 'a@b.c', role: 'admin' } });
    expect(logger.warn).toHaveBeenCalledWith('audit field dropped', {
      event: 'AUDIT_FIELD_DROPPED',
      action: 'admin.invited',
      field: 'inviteToken',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret-token');
  });

  it('a CLI context records actor type cli without a user; no actor at all is a programming error', async () => {
    const { recorder, inserted } = setup();
    await runWithContext({ correlationId: CORRELATION_ID, cli: true }, () =>
      recorder.record(
        { action: 'admin.seeded', targetId: 'u-1', after: { email: 'a@b.c', role: 'admin' } },
        TRX,
      ),
    );
    expect(inserted[0]).toMatchObject({ actorType: 'cli', actorUserId: null, ip: null });

    await expect(
      runWithContext({ correlationId: CORRELATION_ID }, () =>
        recorder.record({ action: 'user.invite_resent', targetId: 'u-1' }, TRX),
      ),
    ).rejects.toThrow('has no actor');
    await expect(recorder.record({ action: 'user.invite_resent', targetId: 'u-1' }, TRX)).rejects.toThrow();
  });
});

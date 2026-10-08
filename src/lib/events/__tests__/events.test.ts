import { describe, expect, it } from 'vitest';
import { jobLockKey } from '../../jobs';
import { ALL_EVENT_CONTRACTS, outboxBackoffMs } from '..';

describe('lib/events', () => {
  it('registers all 22 contracts of docs/spec/02-events.md with unique names and version 1', () => {
    expect(ALL_EVENT_CONTRACTS).toHaveLength(22);
    const types = ALL_EVENT_CONTRACTS.map((contract) => contract.type);
    expect(new Set(types).size).toBe(22);
    for (const contract of ALL_EVENT_CONTRACTS) {
      expect(contract.type).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(contract.version).toBe(1);
      expect(Object.isFrozen(contract)).toBe(true);
    }
  });

  it('backs off exponentially from 1 s and caps at the max', () => {
    expect([1, 2, 3, 4].map((attempts) => outboxBackoffMs(attempts, 300_000))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(outboxBackoffMs(30, 300_000)).toBe(300_000);
  });

  it('derives a stable, distinct advisory-lock key per job name', () => {
    expect(jobLockKey('outbox-drain')).toBe(jobLockKey('outbox-drain'));
    expect(jobLockKey('outbox-drain')).not.toBe(jobLockKey('outbox-cleanup'));
    expect(Number.isInteger(jobLockKey('x'))).toBe(true);
  });
});

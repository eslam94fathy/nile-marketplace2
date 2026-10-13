import { describe, expect, it } from 'vitest';
import { getContext, runWithContext, setContextUserId } from '..';

describe('lib/context', () => {
  it('keeps the context across awaits and isolates parallel runs', async () => {
    const seen: string[] = [];
    const run = (id: string, delayMs: number) =>
      runWithContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(getContext()?.correlationId ?? 'none');
      });
    await Promise.all([run('a', 20), run('b', 5)]);
    expect(seen).toEqual(['b', 'a']);
    expect(getContext()).toBeUndefined();
  });

  it('sets the user id inside a context only', () => {
    setContextUserId('ignored');
    expect(getContext()).toBeUndefined();
    runWithContext({ correlationId: 'c' }, () => {
      setContextUserId('u-1');
      expect(getContext()?.userId).toBe('u-1');
    });
  });
});

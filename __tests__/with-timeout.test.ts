// ─────────────────────────────────────────────
//  Tests — withTimeout (pure request time-bound)
// ─────────────────────────────────────────────

import { describe, test, expect } from 'vitest';
import { withTimeout } from '../src/network/with-timeout';
import { TimeoutError } from '../src/network/sync-errors';

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise(resolve => setTimeout(() => resolve(value), ms));

describe('withTimeout', () => {
  test('resolves with the op result when it finishes in time', async () => {
    await expect(withTimeout(after(5, 'ok'), 100, 'x')).resolves.toBe('ok');
  });

  test('rejects with a TimeoutError when the op overruns the budget', async () => {
    const p = withTimeout(after(100, 'late'), 10, 'pulling changes');
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    await expect(p).rejects.toMatchObject({ timeoutMs: 10 });
  });

  test('propagates the op rejection unchanged (not masked as a timeout)', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(withTimeout(boom, 100, 'x')).rejects.toThrow('boom');
  });

  test('a non-positive budget disables the bound and returns the op as-is', async () => {
    const op = after(5, 'ok');
    expect(withTimeout(op, 0, 'x')).toBe(op);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { retryAsync } from '../src/utils/retry';

vi.mock('../src/utils/logging', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('retryAsync', () => {
  it('retries until function succeeds', async () => {
    let attempts = 0;
    const result = await retryAsync(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('fail');
        return 'ok';
      },
      { attempts: 5, delayMs: 0, operationName: 'test' },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws last error after max attempts', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('always')));
    await expect(
      retryAsync(fn, { attempts: 2, delayMs: 0, operationName: 'fail' }),
    ).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

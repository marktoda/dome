import { describe, it, expect, vi } from 'vitest';
import * as logging from '../src/logging';

describe('sanitizeForLogging', () => {
  it('masks sensitive keys recursively', () => {
    const input = {
      password: 'secret',
      nested: { token: 'abc' },
      normal: 'ok',
    };
    const result = logging.sanitizeForLogging({ ...input });
    expect(result).toEqual({ password: '***', nested: { token: '***' }, normal: 'ok' });
  });
});

describe('tryWithErrorLogging utilities', () => {
  it('returns result when successful', () => {
    const fn = vi.fn(() => 1);
    expect(logging.tryWithErrorLogging(fn, 'err')).toBe(1);
  });

  it('returns undefined on sync error', () => {
    const fn = () => { throw new Error('boom'); };
    expect(logging.tryWithErrorLogging(fn, 'msg')).toBeUndefined();
  });

  it('returns undefined on async error', async () => {
    const fn = async () => { throw new Error('boom'); };
    const res = await logging.tryWithErrorLoggingAsync(fn, 'msg');
    expect(res).toBeUndefined();
  });
});

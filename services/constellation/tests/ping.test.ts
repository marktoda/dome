import { describe, it, expect } from 'vitest';
import { ping } from '../src/handlers/rpc';

describe('ping', () => {
  it('returns ok status', async () => {
    const res = await ping.call({ env: {} });
    expect(res).toEqual({ status: 'ok' });
  });
});

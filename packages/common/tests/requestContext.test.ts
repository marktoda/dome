import { describe, it, expect, vi } from 'vitest';
import { createRequestContextMiddleware } from '../src/middleware/requestContext';

describe('createRequestContextMiddleware', () => {
  it('uses header value when provided', async () => {
    const c: any = {
      req: { header: vi.fn().mockReturnValue('abc') },
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      header: vi.fn(),
    };
    const next = vi.fn();
    const mw = createRequestContextMiddleware();
    await mw(c, next);
    expect(c.set).toHaveBeenCalledWith('requestId', 'abc');
    expect(c.header).toHaveBeenCalledWith('X-Request-ID', 'abc');
    expect(next).toHaveBeenCalled();
  });

  it('generates id when none provided', async () => {
    const uuid = 'generated';
    vi.spyOn(global.crypto, 'randomUUID').mockReturnValue(uuid as any);
    const c: any = {
      req: { header: vi.fn().mockReturnValue(undefined) },
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
      header: vi.fn(),
    };
    const next = vi.fn();
    const mw = createRequestContextMiddleware();
    await mw(c, next);
    expect(c.set).toHaveBeenCalledWith('requestId', uuid);
    expect(c.header).toHaveBeenCalledWith('X-Request-ID', uuid);
  });
});

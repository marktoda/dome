import { describe, it, expect, vi } from 'vitest';
import { responseHandlerMiddleware } from '../src/middleware/responseHandlerMiddleware';

describe('responseHandlerMiddleware', () => {
  it('wraps plain object responses', async () => {
    const c: any = { json: vi.fn() };
    const next = vi.fn().mockResolvedValue({ hello: 'world' });
    await responseHandlerMiddleware(c, next);
    expect(c.json).toHaveBeenCalledWith({ success: true, data: { hello: 'world' } });
  });

  it('wraps body with status', async () => {
    const c: any = { json: vi.fn() };
    const next = vi.fn().mockResolvedValue({ body: { ok: true }, status: 201 });
    await responseHandlerMiddleware(c, next);
    expect(c.json).toHaveBeenCalledWith({ success: true, data: { ok: true } }, 201);
  });

  it('returns Response objects untouched', async () => {
    const response = new Response('ok', { status: 200 });
    const c: any = { json: vi.fn() };
    const next = vi.fn().mockResolvedValue(response);
    const result = await responseHandlerMiddleware(c, next);
    expect(result).toBe(response);
  });
});

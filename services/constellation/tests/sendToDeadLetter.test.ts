import { describe, it, expect, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(_c: any, public env: any) {} }
}));

vi.mock('../src/utils/logging', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logError: vi.fn(),
  trackOperation: async (_n: string, fn: () => Promise<any>) => fn(),
  constellationMetrics: {
    counter: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: () => ({ stop: vi.fn() }),
  },
}));

vi.mock('../src/utils/errors', () => ({
  toDomeError: (e: any) => e,
}));

vi.mock('@dome/common', async () => {
  const actual = await vi.importActual<any>('@dome/common');
  return { ...actual };
});


import { sendToDeadLetter } from '../src';

describe('sendToDeadLetter', () => {
  it('sends a serialized message', async () => {
    const queue = { send: vi.fn() } as any;
    const payload = { error: 'oops', originalMessage: { id: 1 } } as any;
    await sendToDeadLetter.call({ wrap: async (_m: any, fn: any) => fn() }, queue, payload, 'req1');
    expect(queue.send).toHaveBeenCalledTimes(1);
    const arg = queue.send.mock.calls[0][0];
    expect(typeof arg).toBe('string');
    expect(() => JSON.parse(arg)).not.toThrow();
  });

  it('throws for invalid payload', async () => {
    const queue = { send: vi.fn() } as any;
    const badPayload = { foo: 'bar' } as any;
    await expect(
      sendToDeadLetter.call({ wrap: async (_m: any, fn: any) => fn() }, queue, badPayload, 'req2')
    ).rejects.toThrow();
  });
});

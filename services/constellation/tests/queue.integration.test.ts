import { describe, it, expect, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class { env: any; constructor(_c: any, env: any) { this.env = env; } } }));
vi.mock('@dome/common', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  PUBLIC_USER_ID: 'public',
  withContext: async (_m: any, fn: any) => fn({}),
  parseMessageBatch: (_schema: any, batch: any) => ({
    queue: batch.queue,
    messages: batch.messages.map((m: any) => ({
      id: m.id,
      timestamp: m.timestamp,
      body: { id: m.id, userId: 'u', category: 'cat', mimeType: 'text', createdAt: Date.now() },
    })),
  }),
  NewContentMessageSchema: {},
  toRawMessageBatch: (b: any) => b,
}));
vi.mock('@dome/errors', () => ({}));
vi.mock('../src/utils/errors', () => ({
  assertValid: () => {},
  assertExists: () => {},
  toDomeError: (e: any) => e,
  VectorizeError: class extends Error {},
  EmbeddingError: class extends Error {},
}));
vi.mock('@dome/silo/client', () => ({ SiloClient: class { constructor(){} get(){return Promise.resolve({ id: 'id', userId: 'u', body: 'text' });} } }));
import Constellation from '../src';

vi.mock('../src/utils/logging', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logError: vi.fn(),
  trackOperation: async (_n: string, fn: () => Promise<any>) => fn(),
  constellationMetrics: {
    counter: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: () => ({ stop: vi.fn() }),
  },
}));

describe('queue integration', () => {
  it('parses messages and embeds valid items', async () => {
    const env = { EMBED_DEAD: {} } as any;
    const ctx = {} as any;
    const worker = new Constellation(ctx, env);

    const embedSpy = vi.spyOn(worker as any, 'embedBatch').mockResolvedValue(1);

    const mkMsg = (id: string) => ({
      id,
      timestamp: new Date(),
      body: {},
      attempts: 0,
      ack: vi.fn(),
      retry: vi.fn(),
    });

    const batch = { queue: 'q', messages: [mkMsg('a'), mkMsg('b')], ackAll: vi.fn(), retryAll: vi.fn() } as any;

    await worker.queue(batch);

    expect(embedSpy).toHaveBeenCalledTimes(1);
  });
});

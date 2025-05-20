import { describe, it, expect, vi } from 'vitest';
vi.mock('@dome/common', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), PUBLIC_USER_ID: 'public', withContext: async (_m: any, fn: any) => fn({}) }));
vi.mock('../src/utils/errors', () => ({ assertValid: () => {}, assertExists: () => {}, VectorizeError: class extends Error {}, toDomeError: (e:any)=>e }));
import { VectorizeService } from '../src/services/vectorize';
import { PUBLIC_USER_ID } from '@dome/common';

vi.mock('../src/utils/logging', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logError: vi.fn(),
  trackOperation: async (_name: string, fn: () => Promise<any>) => fn(),
  constellationMetrics: {
    counter: vi.fn(),
    gauge: vi.fn(),
    startTimer: () => ({ stop: vi.fn() }),
    timing: vi.fn(),
  },
}));

describe('VectorizeService', () => {
  it('does nothing for empty upsert', async () => {
    const idx = { upsert: vi.fn(), describe: vi.fn(async () => ({ vectorCount: 0, dimensions: 0 })) } as any;
    const svc = new VectorizeService(idx, { maxBatchSize: 2 });
    await svc.upsert([]);
    expect(idx.upsert).not.toHaveBeenCalled();
  });

  it('splits upsert into batches', async () => {
    const idx = {
      upsert: vi.fn(async () => {}),
      describe: vi.fn(async () => ({ vectorCount: 0, dimensions: 0 })),
    } as any;
    const svc = new VectorizeService(idx, { maxBatchSize: 2 });
    const vecs = [1,2,3,4,5].map(i => ({ id: `${i}`, values: [i], metadata: { userId: 'u1' } }));
    await svc.upsert(vecs as any);
    expect(idx.upsert).toHaveBeenCalledTimes(3);
  });

  it('merges PUBLIC_USER_ID on query', async () => {
    const idx = {
      query: vi.fn(async (_v: number[], opts: any) => ({ matches: [], ...opts })),
      describe: vi.fn(),
    } as any;
    const svc = new VectorizeService(idx, {});
    await svc.query([1,2], { userId: 'u1' }, 5);
    expect(idx.query).toHaveBeenCalledWith(
      [1,2],
      expect.objectContaining({
        filter: { userId: { $in: ['u1', PUBLIC_USER_ID] } },
        topK: 5,
        returnMetadata: true,
      }),
    );
  });
});

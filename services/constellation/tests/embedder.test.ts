import { describe, it, expect, vi } from 'vitest';
vi.mock('@dome/common', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), PUBLIC_USER_ID: 'public', withContext: async (_m: any, fn: any) => fn({}) }));
vi.mock('../src/utils/errors', () => ({ EmbeddingError: class extends Error {}, assertValid: () => {}, assertExists: () => {}, toDomeError: (e: any) => e }));
import { Embedder } from '../src/services/embedder';

vi.mock('../src/utils/constellationLogging', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logError: vi.fn(),
  constellationMetrics: {
    counter: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: () => ({ stop: vi.fn() }),
  },
}));

describe('Embedder', () => {
  it('returns empty array for empty input', async () => {
    const ai = { run: vi.fn() } as any;
    const embedder = new Embedder(ai);
    const result = await embedder.embed([]);
    expect(result).toEqual([]);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('calls AI once for small batches', async () => {
    const ai = {
      run: vi.fn(async (_model: string, input: any) => ({
        shape: [input.text.length, 1],
        data: input.text.map((t: string) => [t.length]),
      })),
    } as any;
    const embedder = new Embedder(ai, { maxBatchSize: 5 });
    const texts = ['a', 'bb'];
    const res = await embedder.embed(texts);
    expect(res).toEqual([[1], [2]]);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it('splits input into multiple batches', async () => {
    const ai = {
      run: vi.fn(async (_model: string, input: any) => ({
        shape: [input.text.length, 1],
        data: input.text.map((t: string) => [t.length]),
      })),
    } as any;
    const embedder = new Embedder(ai, { maxBatchSize: 2 });
    const texts = ['one', 'two', 'three', 'four', 'five'];
    const res = await embedder.embed(texts);
    expect(res.length).toBe(5);
    expect(ai.run).toHaveBeenCalledTimes(3);
  });
});

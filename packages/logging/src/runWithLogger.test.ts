import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithLogger } from './runWithLogger';

// Mock the ExecutionContext
const mockCtx = {
  run: vi.fn(fn => fn()),
};

// Mock the hono/context-storage module
vi.mock('hono/context-storage', () => ({
  getContext: vi.fn().mockReturnValue(null),
}));

describe('runWithLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run a function with logger context', async () => {
    const meta = { test: 'value', trigger: 'test' };
    const fn = vi.fn().mockResolvedValue('result');

    const result = await runWithLogger(meta, fn, mockCtx as any);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should fall back to direct function call if no context', async () => {
    const meta = { test: 'value' };
    const fn = vi.fn().mockResolvedValue('result');

    // Pass undefined as context
    const result = await runWithLogger(meta, fn, undefined);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithLogger } from './runWithLogger';
import { baseLogger } from './base';

// Mock the ExecutionContext
const mockCtx = {
  run: vi.fn(fn => fn()),
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn()
};

// Mock the hono/context-storage module
vi.mock('hono/context-storage', () => {
  const mockGetContext = vi.fn();
  return {
    getContext: mockGetContext
  };
});

// Import the mocked module after mocking
import { getContext } from 'hono/context-storage';

describe('runWithLogger', () => {
  // Mock console.log to prevent test output pollution
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.clearAllMocks();
    
    // Spy on baseLogger.child
    vi.spyOn(baseLogger, 'child').mockImplementation((bindings) => {
      return {
        ...baseLogger,
        bindings: () => bindings,
        warn: vi.fn()
      } as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should run a function with logger context when execution context is provided', async () => {
    // Setup mock context storage
    const mockStorage = {
      get: vi.fn(),
      set: vi.fn()
    };
    (getContext as any).mockReturnValue(mockStorage);
    
    const meta = { test: 'value', trigger: 'test' };
    const fn = vi.fn().mockResolvedValue('result');

    const result = await runWithLogger(meta, fn, mockCtx as any);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(baseLogger.child).toHaveBeenCalledWith(meta);
    expect(mockCtx.run).toHaveBeenCalled();
    expect(mockStorage.set).toHaveBeenCalled();
  });

  it('should fall back to direct function call if no execution context', async () => {
    const meta = { test: 'value' };
    const fn = vi.fn().mockResolvedValue('result');

    // Pass undefined as context
    const result = await runWithLogger(meta, fn, undefined);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(baseLogger.child).toHaveBeenCalledWith(meta);
  });
  
  it('should handle errors when accessing context storage', async () => {
    // Mock getContext to throw an error
    (getContext as any).mockImplementation(() => {
      throw new Error('Context access error');
    });
    
    const meta = { test: 'value' };
    const fn = vi.fn().mockResolvedValue('result');
    
    const result = await runWithLogger(meta, fn, mockCtx as any);
    
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    // Child logger should have been created
    expect(baseLogger.child).toHaveBeenCalledWith(meta);
  });
});

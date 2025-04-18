import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runWithLogger } from './runWithLogger';
import { baseLogger } from './base';
import { Logger } from 'pino';

// Mock the ExecutionContext
const mockCtx = {
  run: vi.fn(fn => fn()),
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
};

// Mock the hono/context-storage module
vi.mock('hono/context-storage', () => {
  const mockGetContext = vi.fn();
  return {
    getContext: mockGetContext,
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
    vi.spyOn(baseLogger, 'child').mockImplementation(bindings => {
      return {
        ...baseLogger,
        bindings: () => bindings,
        warn: vi.fn(),
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
      set: vi.fn(),
    };
    (getContext as any).mockReturnValue(mockStorage);

    const meta = { test: 'value', trigger: 'test' };
    const mockChildLogger = { debug: vi.fn() };
    (baseLogger.child as any).mockReturnValue(mockChildLogger);
    
    const fn = vi.fn(async (log: Logger) => {
      expect(log).toBe(mockChildLogger);
      return 'result';
    });

    const result = await runWithLogger(meta, "info", fn, mockCtx as any);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(baseLogger.child).toHaveBeenCalledWith(meta, { level: "info" });
    expect(mockCtx.run).toHaveBeenCalled();
    expect(mockStorage.set).toHaveBeenCalled();
  });

  it('should set logger in context if already inside ALS but no execution context', async () => {
    // Setup mock context storage
    const mockStorage = {
      get: vi.fn(),
      set: vi.fn(),
    };
    (getContext as any).mockReturnValue(mockStorage);

    const meta = { test: 'value' };
    const mockChildLogger = { debug: vi.fn() };
    (baseLogger.child as any).mockReturnValue(mockChildLogger);
    
    const fn = vi.fn(async (log: Logger) => {
      expect(log).toBe(mockChildLogger);
      return 'result';
    });

    // Pass undefined as context
    const result = await runWithLogger(meta, "info", fn, undefined);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(baseLogger.child).toHaveBeenCalledWith(meta, { level: "info" });
    expect(mockStorage.set).toHaveBeenCalledWith('logger', mockChildLogger);
  });

  it('should log debug message when no ALS context is available', async () => {
    // Mock getContext to return undefined
    (getContext as any).mockReturnValue(undefined);

    const meta = { test: 'value' };
    const mockChildLogger = { debug: vi.fn() };
    (baseLogger.child as any).mockReturnValue(mockChildLogger);
    
    const fn = vi.fn(async (log: Logger) => {
      expect(log).toBe(mockChildLogger);
      return 'result';
    });

    const result = await runWithLogger(meta, "info", fn, undefined);

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(baseLogger.child).toHaveBeenCalledWith(meta, { level: "info" });
    expect(mockChildLogger.debug).toHaveBeenCalledWith('No async-context, direct logger in use');
  });
});

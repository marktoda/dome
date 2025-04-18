import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLogging, getLogger } from './index';

// Mock Hono
const mockHono = {
  use: vi.fn(),
};

// Mock the hono/context-storage module
vi.mock('hono/context-storage', () => ({
  contextStorage: vi.fn(),
  getContext: vi.fn().mockReturnValue(null)
}));

describe('@dome/logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize logging middleware', () => {
    initLogging(mockHono as any);
    
    expect(mockHono.use).toHaveBeenCalledTimes(2);
  });

  it('should return a logger', () => {
    const logger = getLogger();
    
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });
});
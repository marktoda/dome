import { describe, it, expect, vi, beforeEach } from 'vitest';
import { baseLogger } from './base';
import { getLogger } from './helper';

// Mock the hono/context-storage module
vi.mock('hono/context-storage', () => ({
  getContext: vi.fn().mockReturnValue(null),
}));

describe('getLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

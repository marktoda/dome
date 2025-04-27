// Import vitest for mocking
import { vi } from 'vitest';
import { TextEncoder, TextDecoder } from 'util';

// Mock global objects that are available in Cloudflare Workers
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock ReadableStream if not available
if (typeof ReadableStream === 'undefined') {
  global.ReadableStream = class ReadableStream {
    constructor(options: any) {
      this._options = options;
    }
    _options: any;
  };
}

// Mock performance API
if (typeof performance === 'undefined') {
  global.performance = {
    now: () => Date.now(),
  };
}

// Mock crypto API
if (typeof crypto === 'undefined') {
  global.crypto = {
    subtle: {},
    getRandomValues: (arr: Uint8Array) => {
      const bytes = new Uint8Array(arr.length);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
      return bytes;
    },
  };
}

// Mock @dome/logging
vi.mock('@dome/logging', () => {
  // Create a mockLogger that can be reused
  const mockChildLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => mockChildLogger),
  };

  return {
    getLogger: vi.fn(() => mockLogger),
    logError: vi.fn(),
    metrics: {
      increment: vi.fn(),
      timing: vi.fn(),
      gauge: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    },
    withLogger: vi.fn((_, fn) => fn()),
    baseLogger: mockLogger,
    createLogger: vi.fn(() => mockLogger),
    createServiceMetrics: vi.fn(() => ({
      counter: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn(),
    })),
  };
});

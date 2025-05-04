// Import vitest for mocking
import { vi } from 'vitest';
import { TextEncoder, TextDecoder } from 'util';

// Define interfaces for our mock objects
interface MockLoggerInterface {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

// Mock basic globals
// Note: We're using ts-ignore to bypass TypeScript errors with global objects
// This is safe in a test environment where we're just providing minimal implementations
// @ts-ignore
global.TextEncoder = TextEncoder;
// @ts-ignore
global.TextDecoder = TextDecoder;

// Mock ReadableStream if not available
if (typeof ReadableStream === 'undefined') {
  // @ts-ignore
  global.ReadableStream = class MockReadableStream {
    constructor(options: any) {
      this._options = options;
    }
    _options: any;
  };
}

// Mock performance API
if (typeof performance === 'undefined') {
  // @ts-ignore
  global.performance = {
    now: () => Date.now(),
  };
}

// Mock crypto API
if (typeof crypto === 'undefined') {
  // @ts-ignore
  global.crypto = {
    subtle: {},
    getRandomValues: (arr: Uint8Array) => {
      const bytes = new Uint8Array(arr.length);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
      return bytes;
    },
    randomUUID: () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
  };
}

// Mock @dome/common
vi.mock('@dome/common', () => {
  // Create mock child logger function that returns a consistent interface
  const createChildLogger = (): MockLoggerInterface => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn()
    })
  });
  
  // Create base logger that can spawn child loggers
  const mockLogger: MockLoggerInterface = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockImplementation(() => createChildLogger())
  };

  // Create mock metrics functions
  const mockMetrics = {
    increment: vi.fn(),
    timing: vi.fn(),
    gauge: vi.fn(),
    startTimer: vi.fn(() => ({ stop: vi.fn() })),
    trackOperation: vi.fn().mockImplementation((name, fn) => fn())
  };

  // Return fully mocked dome/logging module
  return {
    getLogger: vi.fn().mockReturnValue(mockLogger),
    logError: vi.fn(),
    metrics: mockMetrics,
    withLogger: vi.fn().mockImplementation((_, fn) => fn()),
    baseLogger: mockLogger,
    createLogger: vi.fn().mockReturnValue(createChildLogger()),
    createServiceMetrics: vi.fn().mockReturnValue({
      counter: vi.fn(),
      gauge: vi.fn(),
      timing: vi.fn(),
      startTimer: vi.fn(() => ({ stop: vi.fn() })),
      trackOperation: vi.fn().mockImplementation((name, fn) => fn())
    })
  };
});

// Mock SearchService for integration tests
vi.mock('../src/services/searchService', () => ({
  SearchService: {
    search: vi.fn(),
    extractSourceMetadata: vi.fn(),
    rankAndFilterDocuments: vi.fn(),
    fromEnv: vi.fn()
  }
}));

// Ensure that environment variables needed for tests are set
// This prevents errors when environment variables are required
process.env.CHAT_ENCRYPTION_KEY = 'test-encryption-key-for-tests-only';

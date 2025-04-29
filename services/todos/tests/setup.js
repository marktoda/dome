import { vi } from 'vitest';

// Mock pino logger to prevent transport errors
vi.mock('pino', () => {
  return {
    default: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
  };
});

// Mock @dome/logging
vi.mock('@dome/logging', () => {
  return {
    getLogger: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }),
    withLogger: vi.fn((_, fn) => fn()),
  };
});

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => {
  return {};
});

// Mock global objects for testing
global.Response = class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.statusText = init.statusText || '';
    this.headers = new Map(Object.entries(init.headers || {}));
  }

  json() {
    return Promise.resolve(JSON.parse(this.body));
  }

  text() {
    return Promise.resolve(this.body);
  }
};

// Mock fetch
global.fetch = vi.fn();

// Mock Cloudflare Workers environment
global.caches = {
  default: {
    match: vi.fn(),
    put: vi.fn(),
  },
};

// Mock ExecutionContext
global.ExecutionContext = class ExecutionContext {
  waitUntil() {}
  passThroughOnException() {}
};

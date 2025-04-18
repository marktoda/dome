import { vi } from 'vitest';

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

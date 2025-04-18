import { vi } from 'vitest';

// Mock Cloudflare Workers environment
global.addEventListener = vi.fn();
global.fetch = vi.fn();
global.Response = class Response {
  constructor(body, init) {
    this.body = body;
    this.init = init;
    this.status = init?.status || 200;
    this.statusText = init?.statusText || 'OK';
    this.headers = new Headers(init?.headers);
  }
};
global.Headers = class Headers {
  constructor(init) {
    this.headers = new Map();
    if (init) {
      Object.entries(init).forEach(([key, value]) => {
        this.headers.set(key.toLowerCase(), value);
      });
    }
  }
  get(key) {
    return this.headers.get(key.toLowerCase());
  }
  set(key, value) {
    this.headers.set(key.toLowerCase(), value);
  }
  has(key) {
    return this.headers.has(key.toLowerCase());
  }
};
global.Request = class Request {
  constructor(url, init) {
    this.url = url;
    this.method = init?.method || 'GET';
    this.headers = new Headers(init?.headers);
    this.body = init?.body;
    this.cf = {
      colo: 'TEST',
      country: 'XX',
      asn: 12345,
    };
  }
};

// Mock Cloudflare Workers ExecutionContext
global.ExecutionContext = class {
  constructor() {
    this.waitUntil = vi.fn();
    this.passThroughOnException = vi.fn();
    this.run = vi.fn(fn => fn());
  }
};

// Set default log level for tests
global.LOG_LEVEL = 'silent';

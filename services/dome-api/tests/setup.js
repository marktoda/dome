/**
 * Jest setup file for Cloudflare Worker environment
 */

// Import vi from vitest for mocking
import { vi } from 'vitest';

// Global mock for @dome/common to provide a basic getLogger
// This helps tests that indirectly depend on @dome/common via other modules (e.g., @dome/chat/client)
// without needing to mock it in every single test file.
// Test files that need more specific mocks for @dome/common can still define their own.
vi.mock('@dome/common', () => {
  // Simplified mock: If importActual is failing due to path/alias issues,
  // this provides a basic getLogger. Other exports from @dome/common will be missing.
  const mockLogger = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => mockLogger),
  };
  return {
    getLogger: vi.fn(() => mockLogger),
    // Explicitly mock other functions from @dome/common if they are essential globally
    // and vi.importActual was indeed the problem.
    // For now, focus on getLogger.
    updateContext: vi.fn().mockResolvedValue(undefined), // Example if needed
    logError: vi.fn(), // Example if needed
    // Any other exports from @dome/common used by dependencies like @dome/chat/client
    // would need to be explicitly mocked here if not spreading `actual`.
  };
});
// Import Jest globals
const { expect, describe, it, beforeEach, afterEach, beforeAll, afterAll } = global;

// Mock Cloudflare Worker environment
global.Request = class Request {};
global.Response = class Response {
  constructor(body, init) {
    this.body = body;
    this.init = init;
    this.status = init?.status || 200;
    this.statusText = init?.statusText || '';
    this.headers = new Headers(init?.headers || {});
  }

  json() {
    return Promise.resolve(JSON.parse(this.body));
  }

  text() {
    return Promise.resolve(this.body);
  }
};
global.Headers = class Headers {
  constructor(init) {
    this.headers = {};
    if (init) {
      Object.keys(init).forEach(key => {
        this.headers[key.toLowerCase()] = init[key];
      });
    }
  }

  get(name) {
    return this.headers[name.toLowerCase()];
  }

  set(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  append(name, value) {
    const key = name.toLowerCase();
    if (this.headers[key]) {
      this.headers[key] = `${this.headers[key]}, ${value}`;
    } else {
      this.headers[key] = value;
    }
  }

  delete(name) {
    delete this.headers[name.toLowerCase()];
  }

  has(name) {
    return name.toLowerCase() in this.headers;
  }
};

// Mock Cloudflare D1 Database
global.D1Database = class D1Database {
  async prepare() {
    return {
      bind: () => this,
      first: () => Promise.resolve({}),
      all: () => Promise.resolve([]),
      run: () => Promise.resolve({ success: true }),
    };
  }

  async batch() {
    return Promise.resolve([]);
  }

  async exec() {
    return Promise.resolve({ success: true });
  }
};

// Mock Cloudflare Vectorize
global.VectorizeIndex = class VectorizeIndex {
  async query() {
    return Promise.resolve({ matches: [] });
  }

  async insert() {
    return Promise.resolve({ success: true });
  }

  async upsert() {
    return Promise.resolve({ success: true });
  }

  async delete() {
    return Promise.resolve({ success: true });
  }
};

// Mock Cloudflare R2 Bucket
global.R2Bucket = class R2Bucket {
  async get() {
    return Promise.resolve(null);
  }

  async put() {
    return Promise.resolve({ success: true });
  }

  async delete() {
    return Promise.resolve({ success: true });
  }

  async list() {
    return Promise.resolve({ objects: [] });
  }
};

// Mock Cloudflare Queue
global.Queue = class Queue {
  async send() {
    return Promise.resolve({ success: true });
  }

  async sendBatch() {
    return Promise.resolve({ success: true });
  }
};

// Re-export Jest globals
global.describe = describe;
global.it = it;
global.expect = expect;
global.beforeEach = beforeEach;
global.afterEach = afterEach;
global.beforeAll = beforeAll;
global.afterAll = afterAll;

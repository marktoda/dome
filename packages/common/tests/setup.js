/**
 * Vitest setup file for Cloudflare Worker environment
 */

// Import Vitest globals
import { expect, describe, it, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Mock process.env for Cloudflare Worker environment
global.process = {
  env: {
    LOG_LEVEL: 'info',
    SAMPLE_RATE: '1',
    ENVIRONMENT: 'test',
    RELEASE: 'test',
  },
};

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

// Mock crypto for UUID generation
import { vi } from 'vitest';

vi.spyOn(crypto, 'randomUUID').mockImplementation(() => 'test-uuid-1234567890');

// Mock performance API
global.performance = {
  now: () => Date.now(),
  mark: () => {},
  measure: () => {},
};

// No need to re-export Vitest globals as they're automatically available

import { vi } from 'vitest';

// Mock Cloudflare Workers environment
global.addEventListener = vi.fn();
global.fetch = vi.fn();

// Mock Cloudflare Workers ExecutionContext
global.ExecutionContext = class {
  constructor() {
    this.waitUntil = vi.fn();
    this.passThroughOnException = vi.fn();
  }
};
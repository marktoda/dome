// Minimal test setup
export {};
import { vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    env: any;
    constructor(_c: any, env: any) {
      this.env = env;
    }
  }
}));
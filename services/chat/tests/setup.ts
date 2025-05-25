import { vi } from 'vitest';

// Mock cloudflare:workers following the constellation pattern
vi.mock('cloudflare:workers', () => ({ 
  WorkerEntrypoint: class {},
}));

// Mock common dependencies used across tests
vi.mock('@dome/common', () => ({
  getLogger: () => ({
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  logError: vi.fn(),
  withContext: async (_m: any, fn: any) => fn({}),
  metrics: {
    increment: vi.fn(),
  },
}));
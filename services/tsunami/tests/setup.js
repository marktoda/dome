// Minimal test setup
export {};
import { vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));

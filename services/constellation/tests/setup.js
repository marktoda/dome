// Minimal test setup
export {};
import { vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class { constructor(_c, env) { this.env = env; } } }));

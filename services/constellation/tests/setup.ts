import { vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ 
  WorkerEntrypoint: class { 
    constructor(_c: any, env: any) { 
      this.env = env; 
    } 
  } 
}));
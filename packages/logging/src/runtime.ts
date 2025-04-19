import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from 'pino';
import { baseLogger, BaseLogger } from './base';

export const als = new AsyncLocalStorage<Map<string, unknown>>();

// Re-export the base logger type for backward compatibility
export type { BaseLogger };

// Re-export the baseLogger from base.ts
export { baseLogger };

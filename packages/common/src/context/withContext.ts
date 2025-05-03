import { als as loggerAls, baseLogger } from '@dome/logging/runtime';
import type { Logger } from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';

export const als = new AsyncLocalStorage<Map<string, unknown>>();

export type Identity = {
  uid: string;
  email?: string;
  role?: string;
  name?: string;
}

// Create a type for the metadata that includes optional identity
type ContextMeta = Record<string, unknown> & {
  level?: string;
  identity?: Identity;
};


export interface RequestContext {
  logger: Logger;
  /** may be undefined for anonymous calls */
  identity?: Identity;
}

export const ctxStore = new AsyncLocalStorage<RequestContext>();

/* Convenience accessors so you never touch ALS outside this file */
export const getLogger = () => ctxStore.getStore()?.logger;
export const getIdentity = () => ctxStore.getStore()?.identity;


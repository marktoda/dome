import type { Logger } from 'pino';
import { baseLogger } from '../logging';
import { AsyncLocalStorage } from 'node:async_hooks';

export const ctx = new AsyncLocalStorage<RequestContext>();

export type Identity = {
  uid: string;
  email?: string;
  role?: string;
  name?: string;
};

export interface RequestContext {
  logger: Logger;
  /** may be undefined for anonymous calls */
  identity?: Identity;
  requestId?: string;
}

export const ctxStore = new AsyncLocalStorage<RequestContext>();

export const getIdentity: () => Identity | undefined = () => ctxStore.getStore()?.identity;
export const getLogger: () => Logger = () => ctxStore.getStore()?.logger ?? baseLogger;
export const getRequestId: () => string | undefined = () => ctxStore.getStore()?.requestId;

type Meta = Record<string, unknown> & {
  level?: string;
  identity?: Identity;
};

export async function withContext<T>(meta: Meta, fn: (log: Logger) => Promise<T> | T): Promise<T> {
  /* 1 - derive a child logger from the metadata */
  const child = baseLogger.child(meta, { level: meta.level });

  /* 2 - build the context payload */
  const payload: RequestContext = { logger: child, identity: meta.identity };

  /* 3 - run the user callback inside the ALS scope */
  return ctx.run(payload, () => fn(child));
}

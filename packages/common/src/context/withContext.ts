import type { Logger } from 'pino';
import { baseLogger } from '../logging/base.js'; // Import directly from base.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export const ctx = new AsyncLocalStorage<RequestContext>();

export type Identity = {
  userId: string;
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

export const getIdentity: () => Identity = () => {
  const id = ctx.getStore()?.identity;
  if (!id) throw new Error('No identity found in context');
  return id;
};
export const getLogger: () => Logger = () => ctx.getStore()?.logger ?? baseLogger;
export const getRequestId: () => string | undefined = () => ctx.getStore()?.requestId;

type Meta = Record<string, unknown> & {
  level?: string;
  identity?: Identity;
};

export async function withContext<T>(
  meta: Meta,
  fn: (req: RequestContext) => Promise<T> | T,
): Promise<T> {
  const parent = ctx.getStore() ?? { logger: baseLogger };

  // 1. merge parent + overrides
  const merged: RequestContext = {
    ...parent,
    ...meta,
    logger: parent.logger.child(meta), // keep log lineage
  };

  // 2. run with merged store
  return ctx.run(merged, () => fn(merged));
}

export async function updateContext(c: Partial<RequestContext>): Promise<void> {
  let store = ctx.getStore();
  if (!store) {
    throw new Error('No parent context found');
  }

  // TODO: stupid hack for updating the store
  Object.assign(store, c);
}

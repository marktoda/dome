import { createServiceWrapper } from '@dome/common';

/**
 * Service-specific wrapper for the Auth client
 */
const wrapServiceFunction = createServiceWrapper('auth.client');

export async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return wrapServiceFunction(meta, fn);
}

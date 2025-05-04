import { createServiceWrapper } from '@dome/common';

/**
 * Service-specific wrapper for the Constellation service
 * This uses the standardized function wrapper with Constellation-specific context
 */
const wrapServiceFunction = createServiceWrapper('constellation');

/**
 * Wraps a function call with logging context specific to the Constellation service.
 * Provides enhanced error handling and structured logging.
 *
 * @param meta Metadata to include with logs (operation name, IDs, etc.)
 * @param fn The function to execute within this context
 * @returns The result of the function execution
 */
export async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return wrapServiceFunction(meta, fn);
}
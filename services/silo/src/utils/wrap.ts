import { withLogger, getLogger } from '@dome/logging';

/**
 * Wraps a function call with logging context specific to the Silo service.
 */
export async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return withLogger(Object.assign({}, meta, { service: 'silo' }), async () => {
    try {
      return await fn();
    } catch (err) {
      getLogger().error({ err }, 'Unhandled error');
      throw err;
    }
  });
}

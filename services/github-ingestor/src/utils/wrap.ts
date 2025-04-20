import { withLogger, getLogger } from '@dome/logging';
import { metrics } from './metrics';

/**
 * Wraps a function call with logging context specific to the GitHub Ingestor service.
 * Provides consistent error handling and logging patterns.
 * 
 * @param meta Metadata to include in the logging context
 * @param fn Function to execute within the context
 * @returns Result of the function execution
 */
export async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return withLogger(Object.assign({}, meta, { service: 'github-ingestor' }), async () => {
    try {
      const timer = metrics.startTimer(meta.operation as string || 'operation');
      const result = await fn();
      timer.stop();
      return result;
    } catch (err) {
      metrics.counter('error', 1, { 
        operation: meta.operation as string || 'unknown',
        error_type: err instanceof Error ? err.name : 'unknown'
      });
      getLogger().error({ err, ...meta }, 'Unhandled error');
      throw err;
    }
  });
}
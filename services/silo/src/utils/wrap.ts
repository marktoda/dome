import { withLogger, getLogger, logError, trackOperation } from '@dome/logging';
import { toDomeError, DomeError } from '@dome/errors';

/**
 * Wraps a function call with logging context specific to the Silo service.
 * Provides enhanced error handling and structured logging.
 *
 * @param meta Metadata to include with logs (operation name, IDs, etc.)
 * @param fn The function to execute within this context
 * @returns The result of the function execution
 */
export async function wrap<T>(meta: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  // Extract operation name if present for better error context
  const operation = meta.operation || meta.op || 'unknown_operation';
  
  return withLogger(Object.assign({}, meta, { service: 'silo' }), async (logger) => {
    try {
      // If this is a named operation with no specific tracking, use trackOperation
      if (typeof operation === 'string' && !meta.skipTracking) {
        return await trackOperation(
          `silo.${operation}`,
          fn,
          // Filter out operation from context to avoid duplication
          Object.entries(meta)
            .filter(([key]) => key !== 'operation' && key !== 'op')
            .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {})
        );
      }
      
      // Otherwise just run the function
      return await fn();
    } catch (err) {
      // Convert to DomeError for consistent handling
      const domeError = err instanceof DomeError
        ? err
        : toDomeError(
            err,
            `Error in Silo service${operation ? ` during ${operation}` : ''}`,
            // Include original metadata as error context
            meta as Record<string, any>
          );
      
      // Log the error with structured format
      logError(
        domeError,
        `Silo service error${operation ? ` during ${operation}` : ''}`,
        meta as Record<string, any>
      );
      
      // Rethrow the converted error
      throw domeError;
    }
  });
}

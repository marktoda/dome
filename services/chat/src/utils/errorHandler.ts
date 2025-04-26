import { getLogger, logError, metrics } from '@dome/logging';

/**
 * Higher-order function for consistent error handling in controller methods
 * @param operation The name of the operation being performed
 * @param fn The function to wrap with error handling
 * @returns A wrapped function with standardized error handling
 */
export function withErrorHandling<T, Args extends any[]>(
  operation: string,
  fn: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    try {
      return await fn(...args);
    } catch (error) {
      logError(error, `Unhandled error in ${operation}`);
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation,
      });
      throw error;
    }
  };
}

/**
 * Higher-order function for consistent error handling in node implementations
 * @param nodeName The name of the node
 * @param logger The logger instance
 * @param fn The function to wrap with error handling
 * @returns A wrapped function with standardized error handling
 */
export function withNodeErrorHandling<T, Args extends any[]>(
  nodeName: string,
  logger: ReturnType<typeof getLogger>,
  fn: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  return async (...args: Args): Promise<T> => {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error(
        {
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        `Error in ${nodeName} node`,
      );

      // Re-throw the error for the caller to handle
      throw error;
    }
  };
}

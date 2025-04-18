/**
 * Logging Utilities
 *
 * Provides structured logging for the Constellation service.
 */

import { getLogger, BaseLogger } from '@dome/logging';

/**
 * Log an error with additional context
 * @param error Error object
 * @param message Error message
 * @param context Additional context
 */
export function logError(
  error: Error | unknown,
  message: string,
  context: Record<string, any> = {},
) {
  const errorObj =
    error instanceof Error
      ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
          ...context,
        }
      : { error, ...context };

  getLogger().error(errorObj, message);
}

/**
 * Log a performance metric
 * @param name Metric name
 * @param value Metric value (usually time in ms)
 * @param tags Additional tags
 */
export function logMetric(name: string, value: number, tags: Record<string, string> = {}) {
  getLogger().info({ metric: name, value, ...tags }, `Metric: ${name}`);
}

/**
 * Create a timer for measuring operation duration
 * @param name Operation name
 * @returns Timer object with stop method
 */
export function createTimer(name: string) {
  const startTime = performance.now();

  return {
    stop: (tags: Record<string, string> = {}) => {
      const duration = Math.round(performance.now() - startTime);
      logMetric(`${name}.duration_ms`, duration, tags);
      return duration;
    },
  };
}

// Export the logger for direct use
export const logger: BaseLogger = getLogger();

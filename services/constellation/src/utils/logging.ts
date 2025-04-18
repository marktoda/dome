/**
 * Logging Utilities
 *
 * Provides structured logging for the Constellation service.
 */

import { getLogger } from '@dome/logging';

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
  // Create a structured log with metric data as top-level fields
  // This ensures Cloudflare properly parses the metrics instead of embedding them in the message
  getLogger().info({
    metric_name: name,
    metric_value: value,
    metric_type: tags.type || 'gauge',
    ...tags,
  }, 'Metric recorded');
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
      logMetric(`${name}.duration_ms`, duration, { ...tags, type: 'timing' });
      return duration;
    },
  };
}

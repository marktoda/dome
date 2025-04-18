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
  // Create a flat object with all properties at the top level
  const errorObj =
    error instanceof Error
      ? {
          error_message: error.message,
          error_name: error.name,
          error_stack: error.stack,
          ...context,
          // Include the message as a top-level field
          message,
        }
      : {
          // For non-Error objects, stringify them to avoid nested JSON
          error_value: typeof error === 'object' ? JSON.stringify(error) : String(error),
          ...context,
          // Include the message as a top-level field
          message,
        };

  getLogger().error(errorObj);
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
    // Include the message as a top-level field
    message: 'Metric recorded',
  });
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

import { metrics } from '../middleware/metricsMiddleware';

/**
 * Track the timing of an operation
 * @param name Operation name
 * @param tags Additional tags
 * @returns A function that stops the timer and returns the result of the callback
 */
export function trackTiming<T>(name: string, tags: Record<string, string> = {}) {
  return async <T>(callback: () => Promise<T>): Promise<T> => {
    const timer = metrics.startTimer(name, tags);
    try {
      const result = await callback();
      timer.stop({ success: 'true' });
      return result;
    } catch (error) {
      timer.stop({ success: 'false', error_type: error instanceof Error ? error.name : 'unknown' });
      throw error;
    }
  };
}

/**
 * Track the success or failure of an operation
 * @param name Operation name
 * @param tags Additional tags
 * @returns A function that tracks the operation and returns the result of the callback
 */
export function trackOperation<T>(name: string, tags: Record<string, string> = {}) {
  return async <T>(callback: () => Promise<T>): Promise<T> => {
    try {
      const result = await callback();
      metrics.trackOperation(name, true, tags);
      return result;
    } catch (error) {
      metrics.trackOperation(name, false, {
        ...tags,
        error_type: error instanceof Error ? error.name : 'unknown',
      });
      throw error;
    }
  };
}

/**
 * Increment a counter
 * @param name Counter name
 * @param value Amount to increment by (default: 1)
 * @param tags Additional tags
 */
export function incrementCounter(name: string, value = 1, tags: Record<string, string> = {}) {
  metrics.counter(name, value, tags);
}

/**
 * Set a gauge value
 * @param name Gauge name
 * @param value Gauge value
 * @param tags Additional tags
 */
export function setGauge(name: string, value: number, tags: Record<string, string> = {}) {
  metrics.gauge(name, value, tags);
}

/**
 * Get the metrics instance
 * @returns The metrics instance
 */
export function getMetrics() {
  return metrics;
}
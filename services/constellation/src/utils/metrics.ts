/**
 * Metrics Utilities
 *
 * Provides metrics tracking capabilities for the Constellation service.
 */

import { MetricsService, logMetric } from '@dome/common';
import { getLogger } from '@dome/common';

// Re-export logging utilities
export { logMetric };

/**
 * Create a metrics service instance with proper memory management
 * We're creating a simpler implementation that:
 * 1. Uses efficient data structures for counters and gauges
 * 2. Provides all methods needed for testing
 * 3. Properly implements metric tracking interfaces
 */
class EfficientMetricsService {
  private counters: Map<string, number>;
  private gauges: Map<string, number>;

  constructor() {
    this.counters = new Map<string, number>();
    this.gauges = new Map<string, number>();
  }

  /**
   * Increment a counter by a specified amount
   */
  increment(name: string, value = 1, tags: Record<string, string | number> = {}): void {
    const currentValue = this.getCounter(name);
    const newValue = currentValue + value;
    this.counters.set(name, newValue);

    logMetric(name, newValue, { type: 'counter', ...tags });
  }

  /**
   * Decrement a counter by a specified amount, not going below zero
   */
  decrement(name: string, value = 1, tags: Record<string, string | number> = {}): void {
    const currentValue = this.getCounter(name);
    const newValue = Math.max(0, currentValue - value);
    this.counters.set(name, newValue);

    logMetric(name, newValue, { type: 'counter', ...tags });
  }

  /**
   * Set a gauge to a specific value
   */
  gauge(name: string, value: number, tags: Record<string, string | number> = {}): void {
    this.gauges.set(name, value);

    logMetric(name, value, { type: 'gauge', ...tags });
  }

  /**
   * Log a timing metric
   */
  timing(name: string, value: number, tags: Record<string, string | number> = {}): void {
    logMetric(name, value, { type: 'timing', ...tags });
  }

  /**
   * Start a timer for measuring operation duration
   */
  startTimer(operationName: string): { stop: (tags?: Record<string, string | number>) => number } {
    const startTime = Date.now();

    return {
      stop: (tags = {}) => {
        const duration = Date.now() - startTime;
        logMetric(`${operationName}.duration_ms`, duration, { type: 'timing', ...tags });
        return duration;
      },
    };
  }

  /**
   * Track operation success/failure
   */
  trackOperation(
    operationName: string,
    success: boolean,
    tags: Record<string, string | number> = {},
  ): void {
    const metric = success ? `${operationName}.success` : `${operationName}.failure`;
    this.increment(metric, 1, tags);
  }

  /**
   * Get the current value of a counter
   */
  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  /**
   * Get the current value of a gauge
   */
  getGauge(name: string): number {
    return this.gauges.get(name) || 0;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    getLogger().info('Metrics reset');
  }
}

// Export a singleton instance
export const metrics = new EfficientMetricsService();

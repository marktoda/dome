/**
 * Metrics Utilities
 *
 * Provides standardized metrics tracking across services.
 */

import { getLogger } from '../context/index.js';
import type { Logger } from 'pino';

/**
 * Log a performance metric
 * @param name Metric name
 * @param value Metric value
 * @param tags Additional tags
 */
export function logMetric(name: string, value: number, tags: Record<string, string> = {}) {
  // Create a structured log with metric data as top-level fields
  // This ensures Cloudflare properly parses the metrics instead of embedding them in the message
  const metric_type = tags.type || 'gauge';

  // Create a copy of tags without the 'type' property to avoid duplication
  const { type, ...restTags } = tags;

  getLogger().info(
    {
      metric_name: name,
      metric_value: value,
      metric_type,
      ...restTags,
    },
    'Metric recorded',
  );
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

/**
 * Metrics service for tracking performance and operational metrics
 */
export class MetricsService {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private logger: Logger;

  constructor() {
    this.logger = getLogger();
  }

  /**
   * Increment a counter metric
   * @param name Metric name
   * @param value Amount to increment by (default: 1)
   * @param tags Additional tags
   */
  public increment(name: string, value = 1, tags: Record<string, string> = {}): void {
    const currentValue = this.counters.get(name) || 0;
    const newValue = currentValue + value;
    this.counters.set(name, newValue);
    logMetric(name, newValue, { ...tags, type: 'counter' });
  }

  /**
   * Decrement a counter metric
   * @param name Metric name
   * @param value Amount to decrement by (default: 1)
   * @param tags Additional tags
   */
  public decrement(name: string, value = 1, tags: Record<string, string> = {}): void {
    const currentValue = this.counters.get(name) || 0;
    const newValue = Math.max(0, currentValue - value);
    this.counters.set(name, newValue);
    logMetric(name, newValue, { ...tags, type: 'counter' });
  }

  /**
   * Set a gauge metric
   * @param name Metric name
   * @param value Gauge value
   * @param tags Additional tags
   */
  public gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    this.gauges.set(name, value);
    logMetric(name, value, { ...tags, type: 'gauge' });
  }

  /**
   * Record a timing metric
   * @param name Metric name
   * @param value Timing value in milliseconds
   * @param tags Additional tags
   */
  public timing(name: string, value: number, tags: Record<string, string> = {}): void {
    logMetric(name, value, { ...tags, type: 'timing' });
  }

  /**
   * Create a timer for measuring operation duration
   * @param name Operation name
   * @returns Timer object with stop method
   */
  public startTimer(name: string) {
    const startTime = performance.now();

    return {
      stop: (tags: Record<string, string> = {}) => {
        const duration = Math.round(performance.now() - startTime);
        this.timing(`${name}.duration_ms`, duration, tags);
        return duration;
      },
    };
  }

  /**
   * Track the success or failure of an operation
   * @param name Operation name
   * @param success Whether the operation succeeded
   * @param tags Additional tags
   */
  public trackOperation(name: string, success: boolean, tags: Record<string, string> = {}): void {
    const metricName = `${name}.${success ? 'success' : 'failure'}`;
    this.increment(metricName, 1, tags);
  }

  /**
   * Get the current value of a counter
   * @param name Counter name
   * @returns Current counter value
   */
  public getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  /**
   * Get the current value of a gauge
   * @param name Gauge name
   * @returns Current gauge value
   */
  public getGauge(name: string): number {
    return this.gauges.get(name) || 0;
  }

  /**
   * Reset all metrics
   */
  public reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.logger.debug('Metrics reset');
  }
}

/**
 * Singleton metrics service instance
 */
export const metrics = new MetricsService();

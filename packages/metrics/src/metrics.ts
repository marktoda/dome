import { metrics as domeMetrics } from '@dome/logging';
import { MetricsService, Timer } from './types';

/**
 * Service metrics implementation
 * Provides a standardized metrics interface for all Dome services
 */
export class ServiceMetrics implements MetricsService {
  private readonly prefix: string;
  private defaultTagsBase: Record<string, string>;
  private envTags: Record<string, string> = {};
  // Internal counters for tracking metrics in memory
  private counters: Map<string, number> = new Map();

  /**
   * Create a new metrics service
   * @param serviceName Name of the service (used as metric prefix)
   * @param defaultTags Default tags to include with all metrics
   */
  constructor(serviceName: string, defaultTags: Record<string, string> = {}) {
    this.prefix = serviceName.replace(/-/g, '_');
    this.defaultTagsBase = {
      service: serviceName,
      version: 'unknown', // Will be set during initialization
      environment: 'development', // Will be set during initialization
      ...defaultTags,
    };
  }

  /**
   * Initialize metrics with environment variables
   * @param env Environment variables
   */
  public init(env: { VERSION?: string; ENVIRONMENT?: string; [key: string]: any }): void {
    this.envTags = {
      version: env.VERSION || 'unknown',
      environment: env.ENVIRONMENT || 'development',
    };
  }

  /**
   * Get the combined default tags
   */
  private get defaultTags(): Record<string, string> {
    return { ...this.defaultTagsBase, ...this.envTags };
  }

  /**
   * Add default tags to user-provided tags
   * @param tags User-provided tags
   * @returns Combined tags
   */
  private addDefaultTags(tags: Record<string, string> = {}): Record<string, string> {
    return { ...this.defaultTags, ...tags };
  }

  /**
   * Increment a counter metric
   * @param name Metric name
   * @param value Amount to increment by (default: 1)
   * @param tags Additional tags
   */
  public counter(name: string, value = 1, tags: Record<string, string> = {}): void {
    // Update internal counter
    const currentValue = this.counters.get(name) || 0;
    this.counters.set(name, currentValue + value);

    // Send to metrics service
    domeMetrics.increment(`${this.prefix}.${name}`, value, this.addDefaultTags(tags));
  }

  /**
   * Set a gauge metric
   * @param name Metric name
   * @param value Gauge value
   * @param tags Additional tags
   */
  public gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    domeMetrics.gauge(`${this.prefix}.${name}`, value, this.addDefaultTags(tags));
  }

  /**
   * Record a timing metric
   * @param name Metric name
   * @param value Timing value in milliseconds
   * @param tags Additional tags
   */
  public timing(name: string, value: number, tags: Record<string, string> = {}): void {
    domeMetrics.timing(`${this.prefix}.${name}`, value, this.addDefaultTags(tags));
  }

  /**
   * Create a timer for measuring operation duration
   * @param name Operation name
   * @param tags Additional tags to include when the timer stops
   * @returns Timer object with stop method
   */
  public startTimer(name: string, tags: Record<string, string> = {}): Timer {
    const startTime = performance.now();

    return {
      stop: (additionalTags: Record<string, string> = {}) => {
        const duration = Math.round(performance.now() - startTime);
        this.timing(`${name}.duration_ms`, duration, { ...tags, ...additionalTags });
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
    this.counter(metricName, 1, tags);

    // Also track as a gauge for success rate calculation
    this.gauge(`${name}.success_rate`, success ? 1 : 0, tags);
  }

  /**
   * Track API request metrics
   * @param path Request path
   * @param method HTTP method
   * @param statusCode HTTP status code
   * @param duration Request duration in milliseconds
   * @param tags Additional tags
   */
  public trackApiRequest(
    path: string,
    method: string,
    statusCode: number,
    duration: number,
    tags: Record<string, string> = {},
  ): void {
    const requestTags = {
      path,
      method,
      status_code: statusCode.toString(),
      status_category: Math.floor(statusCode / 100).toString() + 'xx',
      ...tags,
    };

    this.counter('api.request', 1, requestTags);
    this.timing('api.request_duration_ms', duration, requestTags);

    // Track errors separately
    if (statusCode >= 400) {
      this.counter('api.error', 1, requestTags);
    }
  }

  /**
   * Track health check metrics
   * @param status Health check status (ok, warning, error)
   * @param duration Check duration in milliseconds
   * @param component Component being checked (optional)
   * @param tags Additional tags
   */
  public trackHealthCheck(
    status: 'ok' | 'warning' | 'error',
    duration: number,
    component?: string,
    tags: Record<string, string> = {},
  ): void {
    const healthTags: Record<string, string> = { status, ...tags };
    if (component) healthTags.component = component;

    this.counter('health.check', 1, healthTags);
    this.timing('health.check_duration_ms', duration, healthTags);

    // Track a numeric value for the status (0 = error, 1 = warning, 2 = ok)
    // This makes it easier to create alerts based on status
    const statusValue = status === 'ok' ? 2 : status === 'warning' ? 1 : 0;
    this.gauge('health.status', statusValue, healthTags);
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
   * Create a metrics factory function for the given service
   * @param serviceName Name of the service
   * @param defaultTags Default tags to include with all metrics
   * @returns Metrics service instance
   */
  public static createMetrics(
    serviceName: string,
    defaultTags: Record<string, string> = {},
  ): ServiceMetrics {
    return new ServiceMetrics(serviceName, defaultTags);
  }
}

/**
 * Create a metrics service for the given service name
 * @param serviceName Name of the service
 * @param defaultTags Default tags to include with all metrics
 * @returns Metrics service instance
 */
export function createMetrics(
  serviceName: string,
  defaultTags: Record<string, string> = {},
): ServiceMetrics {
  return ServiceMetrics.createMetrics(serviceName, defaultTags);
}

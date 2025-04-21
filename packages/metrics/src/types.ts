/**
 * Timer interface for measuring operation duration
 */
export interface Timer {
  /**
   * Stop the timer and record the duration
   * @param additionalTags Additional tags to include with the timing metric
   * @returns Duration in milliseconds
   */
  stop: (additionalTags?: Record<string, string>) => number;
}

/**
 * Metrics service interface
 */
export interface MetricsService {
  /**
   * Initialize metrics with environment variables
   * @param env Environment variables
   */
  init(env: { VERSION?: string; ENVIRONMENT?: string; [key: string]: any }): void;

  /**
   * Increment a counter metric
   * @param name Metric name
   * @param value Amount to increment by (default: 1)
   * @param tags Additional tags
   */
  counter(name: string, value?: number, tags?: Record<string, string>): void;

  /**
   * Set a gauge metric
   * @param name Metric name
   * @param value Gauge value
   * @param tags Additional tags
   */
  gauge(name: string, value: number, tags?: Record<string, string>): void;

  /**
   * Record a timing metric
   * @param name Metric name
   * @param value Timing value in milliseconds
   * @param tags Additional tags
   */
  timing(name: string, value: number, tags?: Record<string, string>): void;

  /**
   * Create a timer for measuring operation duration
   * @param name Operation name
   * @param tags Additional tags to include when the timer stops
   * @returns Timer object with stop method
   */
  startTimer(name: string, tags?: Record<string, string>): Timer;

  /**
   * Track the success or failure of an operation
   * @param name Operation name
   * @param success Whether the operation succeeded
   * @param tags Additional tags
   */
  trackOperation(name: string, success: boolean, tags?: Record<string, string>): void;

  /**
   * Track API request metrics
   * @param path Request path
   * @param method HTTP method
   * @param statusCode HTTP status code
   * @param duration Request duration in milliseconds
   * @param tags Additional tags
   */
  trackApiRequest(
    path: string,
    method: string,
    statusCode: number,
    duration: number,
    tags?: Record<string, string>
  ): void;

  /**
   * Track health check metrics
   * @param status Health check status (ok, warning, error)
   * @param duration Check duration in milliseconds
   * @param component Component being checked (optional)
   * @param tags Additional tags
   */
  trackHealthCheck(
    status: 'ok' | 'warning' | 'error',
    duration: number,
    component?: string,
    tags?: Record<string, string>
  ): void;

  /**
   * Get the current value of a counter
   * @param name Counter name
   * @returns Current counter value
   */
  getCounter(name: string): number;
}
import { Next } from 'hono';
import { Context } from 'hono';
import { getLogger, logError } from '@dome/logging';

// Simple metrics implementation
export const metrics = {
  counter: (name: string, value: number, tags?: Record<string, string>) => {
    getLogger().debug({ name, value, tags }, 'Counter metric');
  },
  timing: (name: string, value: number, tags?: Record<string, string>) => {
    getLogger().debug({ name, value, tags }, 'Timing metric');
  },
  trackApiRequest: (path: string, method: string, status: number, duration: number) => {
    getLogger().debug({ path, method, status, duration }, 'API request metric');
  },
  init: (env: Record<string, any>) => {
    getLogger().debug({ env }, 'Metrics initialized');
  },
  startTimer: (name: string, tags?: Record<string, string>) => {
    getLogger().debug({ name, tags }, 'Timer started');
    const start = Date.now();
    return {
      stop: (additionalTags?: Record<string, string>) => {
        const duration = Date.now() - start;
        getLogger().debug({ name, duration, tags, additionalTags }, 'Timer stopped');
        return duration;
      },
    };
  },
  trackOperation: (name: string, success: boolean, tags?: Record<string, string>) => {
    getLogger().debug({ name, success, tags }, 'Operation tracked');
  },
  gauge: (name: string, value: number, tags?: Record<string, string>) => {
    getLogger().debug({ name, value, tags }, 'Gauge metric');
  },
  getCounter: (name: string) => {
    return 0; // Mock counter value
  },
  trackHealthCheck: (status: string, latency: number, service: string) => {
    getLogger().debug({ status, latency, service }, 'Health check tracked');
  },
};

/**
 * Middleware to track API request metrics
 */
export function metricsMiddleware() {
  return async (c: Context, next: Next) => {
    const startTime = performance.now();
    const path = c.req.path;
    const method = c.req.method;

    // Track request start
    metrics.counter('api.request_started', 1, { path, method });

    try {
      // Execute the request handler
      await next();

      // Calculate request duration
      const duration = Math.round(performance.now() - startTime);
      const statusCode = c.res.status;

      // Track API request metrics
      metrics.trackApiRequest(path, method, statusCode, duration);

      // Track successful requests
      if (statusCode < 400) {
        metrics.counter('api.request_success', 1, { path, method, status: statusCode.toString() });
      } else {
        // Track failed requests
        metrics.counter('api.request_failure', 1, { path, method, status: statusCode.toString() });
      }
    } catch (error: unknown) {
      // Calculate request duration even for errors
      const duration = Math.round(performance.now() - startTime);

      // Track error
      metrics.counter('api.request_error', 1, {
        path,
        method,
        error_type: error instanceof Error ? error.name : 'Unknown',
      });

      // Track API request metrics with 500 status code for unhandled errors
      metrics.trackApiRequest(path, method, 500, duration);

      // Log the error
      logError(error, 'Request error in metrics middleware', {
        path,
        method,
        duration,
      });

      // Re-throw the error to be handled by error middleware
      throw error;
    }
  };
}

/**
 * Initialize metrics with environment variables
 * @param env Environment variables
 */
export function initMetrics(env: {
  VERSION?: string;
  ENVIRONMENT?: string;
  [key: string]: any;
}): void {
  metrics.init(env);
  getLogger().info('Metrics initialized');
}

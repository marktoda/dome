import { Context, Next } from 'hono';
import { getLogger } from './getLogger';
import { withLogger } from './withLogger';
import { metrics } from './metrics';
import { baseLogger } from './runtime';

export * from './runtime';
export * from './getLogger';
export * from './withLogger';
export * from './middleware';
export * from './metrics';
export type { InitOptions } from './types';

// Standardized logging interface
export interface LoggerOptions {
  service: string;
  component?: string;
  version?: string;
  environment?: string;
}

export function createLogger(options: LoggerOptions) {
  return baseLogger.child({
    service: options.service,
    component: options.component,
    version: options.version,
    environment: options.environment || process.env.ENVIRONMENT || 'development',
  });
}

// Consistent context propagation middleware
export function loggerMiddleware() {
  return async (c: Context, next: Next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();

    return withLogger({ requestId, path: c.req.path, method: c.req.method }, async logger => {
      c.set('logger', logger);
      logger.info({ event: 'request_start' });

      const startTime = performance.now();
      try {
        await next();
      } catch (error) {
        logger.error({ event: 'request_error', error });
        throw error;
      } finally {
        logger.info({
          event: 'request_end',
          duration: performance.now() - startTime,
          status: c.res.status,
        });
      }
    });
  };
}

// Standardized metrics collection
export interface ServiceMetrics {
  counter: (name: string, value?: number, tags?: Record<string, string>) => void;
  gauge: (name: string, value: number, tags?: Record<string, string>) => void;
  timing: (name: string, value: number, tags?: Record<string, string>) => void;
  startTimer: (name: string) => { stop: (tags?: Record<string, string>) => number };
  trackOperation: (name: string, success: boolean, tags?: Record<string, string>) => void;
}

export function createServiceMetrics(serviceName: string): ServiceMetrics {
  return {
    counter: (name: string, value = 1, tags = {}) =>
      metrics.increment(`${serviceName}.${name}`, value, tags),
    gauge: (name: string, value: number, tags = {}) =>
      metrics.gauge(`${serviceName}.${name}`, value, tags),
    timing: (name: string, value: number, tags = {}) =>
      metrics.timing(`${serviceName}.${name}`, value, tags),
    startTimer: (name: string) => {
      const timer = metrics.startTimer(`${serviceName}.${name}`);
      return timer;
    },
    trackOperation: (name: string, success: boolean, tags = {}) =>
      metrics.trackOperation(`${serviceName}.${name}`, success, tags),
  };
}

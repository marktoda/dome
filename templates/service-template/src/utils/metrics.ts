import { createServiceMetrics, getLogger } from '@dome/common';
import type { MiddlewareHandler } from 'hono';

// Create service-specific metrics
export const {{SERVICE_NAME}}Metrics = createServiceMetrics('{{SERVICE_NAME}}');

const logger = getLogger().child({ component: 'metrics' });

// Metrics middleware
export const metricsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const start = Date.now();
  const path = c.req.path;
  const method = c.req.method;

  try {
    await next();
    
    const duration = Date.now() - start;
    const status = c.res.status;

    // Record metrics
    {{SERVICE_NAME}}Metrics.incrementCounter('requests_total', {
      method,
      path,
      status: status.toString(),
    });

    {{SERVICE_NAME}}Metrics.recordHistogram('request_duration_ms', duration, {
      method,
      path,
      status: status.toString(),
    });

    logger.debug('Request completed', {
      method,
      path,
      status,
      duration,
    });
  } catch (error) {
    const duration = Date.now() - start;

    {{SERVICE_NAME}}Metrics.incrementCounter('requests_total', {
      method,
      path,
      status: '500',
    });

    {{SERVICE_NAME}}Metrics.incrementCounter('errors_total', {
      method,
      path,
      error: error instanceof Error ? error.name : 'Unknown',
    });

    logger.error('Request failed', {
      method,
      path,
      duration,
      error,
    });

    throw error;
  }
};
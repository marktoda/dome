import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { getLogger, initLogging } from '@dome/common';
import { ServiceErrors, toDomeError } from './utils/errors';
import { metricsMiddleware } from './utils/metrics';

// Initialize service
const app = new Hono<{ Bindings: Env }>();
const serviceLogger = getLogger().child({ service: '{{SERVICE_NAME}}' });

// Middleware
app.use('*', initLogging());
app.use('*', cors());
app.use('*', secureHeaders());
app.use('*', logger());
app.use('*', metricsMiddleware);

// Health check
app.get('/health', (c) => {
  return c.json({ 
    status: 'healthy', 
    service: '{{SERVICE_NAME}}',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.get('/api/{{SERVICE_NAME}}', async (c) => {
  try {
    serviceLogger.info('Processing {{SERVICE_NAME}} request');
    
    // TODO: Implement your service logic here
    
    return c.json({ 
      message: 'Hello from {{SERVICE_NAME}} service',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    serviceLogger.error('Error processing request', { error });
    const domeError = toDomeError(error);
    return c.json({ error: domeError.message }, domeError.status);
  }
});

// Error handling
app.onError((err, c) => {
  serviceLogger.error('Unhandled error', { error: err });
  const domeError = toDomeError(err);
  return c.json({ error: domeError.message }, domeError.status);
});

// 404 handler
app.notFound((c) => {
  serviceLogger.warn('Route not found', { path: c.req.path });
  return c.json({ error: 'Not Found' }, 404);
});

export default app;
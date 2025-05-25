import { Hono } from 'hono';
import { getLogger, createServiceMetrics, createErrorFactory, toDomeError } from '@dome/common';

// Service-specific utilities
const logger = getLogger().child({ service: 'service-name' });
const metrics = createServiceMetrics('service-name');
const ServiceErrors = createErrorFactory('service-name');

// Types
export interface Env {
  // Define your environment variables here
}

// Main application
const app = new Hono<{ Bindings: Env }>();

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'healthy', service: 'service-name' });
});

// Example endpoint
app.get('/api/example', async (c) => {
  try {
    logger.info('Example endpoint called');
    metrics.increment('example_calls');
    
    return c.json({ message: 'Hello from service-name!' });
  } catch (error) {
    const domeError = toDomeError(error, 'Failed to process example request');
    logger.error('Example endpoint failed', { error: domeError });
    metrics.increment('example_errors');
    
    return c.json(
      { error: domeError.message },
      domeError.status || 500
    );
  }
});

export default app;
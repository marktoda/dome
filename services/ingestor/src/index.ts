import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { ApiResponse, ServiceInfo } from '@communicator/common';

/**
 * Environment bindings type
 */
type Bindings = {
  ENVIRONMENT?: string;
};

/**
 * Service information
 */
const serviceInfo: ServiceInfo = {
  name: 'ingestor',
  version: '0.1.0',
  environment: 'development' // Default value, will be overridden by env
};

/**
 * Create Hono app
 */
const app = new Hono<{ Bindings: Bindings }>();

/**
 * Middleware
 */
app.use('*', logger());
app.use('*', cors());

/**
 * Middleware to set service info from environment
 */
app.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT) {
    serviceInfo.environment = c.env.ENVIRONMENT;
  }
  await next();
});

/**
 * Error handling middleware
 */
app.onError((err, c) => {
  console.error(`Error: ${err.message}`);
  
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    }
  };
  
  return c.json(response, 500);
});

/**
 * Not found handler
 */
app.notFound((c) => {
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found'
    }
  };
  
  return c.json(response, 404);
});

/**
 * Routes
 */
app.get('/', (c) => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: 'Hello World from Communicator Ingestor Service!',
      service: serviceInfo
    }
  };
  
  return c.json(response);
});

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * Export the Hono app as the default export
 */
export default app;

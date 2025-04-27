/**
 * @dome/logging Hono Integration Examples
 * 
 * This file demonstrates how to use @dome/logging with Hono web framework,
 * including middleware setup, request logging, error handling, and context access.
 */

import { Hono } from 'hono';
import { 
  initLogging, 
  buildLoggingMiddleware,
  getLogger, 
  logError, 
  createServiceMetrics, 
  trackOperation,
  getRequestId,
  trackedFetch,
  sanitizeForLogging,
  requestIdMiddleware
} from '../src';

// --------------------------------------------------
// Basic Hono App with Default Logging Setup
// --------------------------------------------------

export function createBasicApp() {
  const app = new Hono();
  
  // Initialize logging middleware with default options
  initLogging(app, {
    extraBindings: {
      service: 'example-api',
      version: '1.0.0',
      environment: 'development'
    }
  });
  
  // Define routes
  app.get('/', c => {
    const logger = getLogger();
    logger.info('Handling root request');
    return c.json({ message: 'Hello World' });
  });
  
  app.post('/users', async c => {
    const logger = getLogger();
    logger.info('Creating user');
    
    try {
      const data = await c.req.json();
      logger.debug({ userData: sanitizeForLogging(data) }, 'Received user data');
      
      // Process the request
      const user = await createUser(data);
      
      logger.info({ userId: user.id }, 'User created successfully');
      return c.json({ user });
    } catch (error) {
      logError(error, 'Failed to create user', { path: c.req.path });
      return c.json({ error: 'Failed to create user' }, 500);
    }
  });
  
  app.get('/users/:id', async c => {
    const userId = c.req.param('id');
    const logger = getLogger();
    
    logger.info({ userId }, 'Fetching user');
    
    const user = await getUser(userId);
    if (!user) {
      logger.warn({ userId }, 'User not found');
      return c.json({ error: 'User not found' }, 404);
    }
    
    return c.json({ user });
  });
  
  return app;
}

// --------------------------------------------------
// Advanced Hono App with Custom Logging Configuration
// --------------------------------------------------

export function createAdvancedApp() {
  const app = new Hono();
  
  // Create custom logging middleware with advanced options
  app.use('*', buildLoggingMiddleware({
    extraBindings: {
      service: 'advanced-api',
      version: '2.0.0',
      environment: 'production'
    },
    includeHeaders: true,
    includeRequestBody: true,
    maxBodySize: 1024,
    sensitiveHeaders: ['authorization', 'cookie', 'x-api-key'],
    shouldLogRequest: (c) => !c.req.path.startsWith('/health'),
    metadataExtractor: (c) => ({
      tenant: c.req.header('x-tenant-id') || 'default',
      clientApp: c.req.header('x-client-app') || 'unknown'
    })
  }));
  
  // Add custom middleware to set variables in context
  app.use('*', async (c, next) => {
    c.set('tenant', c.req.header('x-tenant-id') || 'default');
    await next();
  });
  
  // Define routes with error handling
  app.get('/', c => {
    const logger = getLogger();
    const tenant = c.get('tenant');
    
    logger.info({ tenant }, 'Handling root request for tenant');
    return c.json({ message: 'Welcome', tenant });
  });
  
  // Example of external API call with request ID propagation
  app.get('/external-data', async c => {
    const logger = getLogger();
    
    return await trackOperation(
      'fetch-external-data',
      async () => {
        // trackedFetch automatically propagates request ID and logs the call
        const response = await trackedFetch(
          'https://api.example.com/data',
          {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
          },
          { 
            tenant: c.get('tenant'),
            operation: 'external-api-request'
          }
        );
        
        if (!response.ok) {
          throw new Error(`External API returned ${response.status}`);
        }
        
        const data = await response.json();
        return c.json({ data });
      },
      { path: c.req.path }
    );
  });
  
  // Demonstrate metrics tracking
  app.get('/metrics-example', async c => {
    const logger = getLogger();
    const metrics = createServiceMetrics('advanced-api');
    
    // Increment request counter
    metrics.counter('requests.count');
    
    const timer = metrics.startTimer('request.duration');
    try {
      // Some complex operation
      await simulateWork(200);
      
      metrics.trackOperation('complex-operation', true);
      timer.stop();
      
      return c.json({ success: true });
    } catch (error) {
      metrics.trackOperation('complex-operation', false);
      timer.stop();
      
      logError(error, 'Complex operation failed');
      return c.json({ error: 'Operation failed' }, 500);
    }
  });
  
  // Return the configured app
  return app;
}

// --------------------------------------------------
// Error handling with middleware
// --------------------------------------------------

export function createAppWithErrorHandler() {
  const app = new Hono();
  
  // Add request ID middleware
  app.use('*', requestIdMiddleware());
  
  // Add logging middleware
  app.use('*', buildLoggingMiddleware({
    extraBindings: {
      service: 'error-handling-example',
      version: '1.0.0'
    }
  }));
  
  // Add custom error handling middleware
  app.use('*', async (c, next) => {
    try {
      await next();
    } catch (error) {
      const logger = getLogger();
      
      logError(error, 'Unhandled error in request', {
        path: c.req.path,
        method: c.req.method
      });
      
      // Determine status code
      let status = 500;
      let message = 'Internal server error';
      
      if (error instanceof Error) {
        // Customize based on error type
        if ((error as any).statusCode) {
          status = (error as any).statusCode;
        }
        
        message = error.message;
      }
      
      return c.json({
        error: {
          message,
          requestId: getRequestId() || 'unknown'
        }
      }, status);
    }
  });
  
  // Define routes that might throw errors
  app.get('/safe', c => {
    const logger = getLogger();
    logger.info('Handling safe request');
    return c.json({ message: 'This endpoint is safe' });
  });
  
  app.get('/error', c => {
    const logger = getLogger();
    logger.info('About to throw an error');
    
    // This error will be caught by our middleware
    throw new Error('This is a demonstration error');
  });
  
  app.get('/typed-error', c => {
    const logger = getLogger();
    logger.info('About to throw a typed error');
    
    // Create an error with status code
    const error = new Error('Invalid request parameters');
    (error as any).statusCode = 400;
    throw error;
  });
  
  return app;
}

// --------------------------------------------------
// Helper functions
// --------------------------------------------------

async function createUser(data: any) {
  // Validate user data
  if (!data.email) {
    throw new Error('Email is required');
  }
  
  // Log with redacted sensitive data
  const logger = getLogger();
  logger.debug(
    { userData: sanitizeForLogging(data) },
    'Creating user in database'
  );
  
  // Simulate database operation
  await simulateWork(100);
  
  return {
    id: crypto.randomUUID(),
    email: data.email,
    name: data.name,
    createdAt: new Date().toISOString()
  };
}

async function getUser(id: string) {
  const logger = getLogger();
  
  logger.debug({ userId: id }, 'Fetching user from database');
  
  // Simulate database lookup
  await simulateWork(50);
  
  // Simulate user not found for specific ID
  if (id === 'not-found') {
    return null;
  }
  
  return {
    id,
    email: `user-${id}@example.com`,
    name: `User ${id}`,
    createdAt: new Date().toISOString()
  };
}

async function simulateWork(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------------------------------------
// Example usage
// --------------------------------------------------

// You can run these examples with:
// 
// const app = createBasicApp();
// export default app;
// 
// Or:
// 
// const app = createAdvancedApp();
// export default app;
// 
// Or:
// 
// const app = createAppWithErrorHandler();
// export default app;

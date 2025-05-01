import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getLogger, initLogging } from '@dome/logging';
import {
  createErrorMiddleware,
  createRequestContextMiddleware,
  responseHandlerMiddleware,
  formatZodError,
} from '@dome/common';
import { createAuthService } from './services/authService';
import { createAuthController } from './controllers/authController';
import { Bindings } from './types';

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Initialize logging
initLogging(app, {
  extraBindings: {
    name: 'auth-service',
    version: '0.1.0',
    environment: 'development',
  },
});

// App middleware
app.use('*', createRequestContextMiddleware());
app.use('*', cors());
app.use('*', createErrorMiddleware(formatZodError));
app.use('*', responseHandlerMiddleware);

// Log application startup
getLogger().info('Auth service starting');

// Root route
app.get('/', c => {
  return c.json({
    message: 'Auth service API',
    service: 'dome-auth',
    version: c.env.VERSION || '0.1.0',
  });
});

// Health check endpoint
app.get('/health', c => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'dome-auth',
    version: c.env.VERSION || '0.1.0',
  });
});

// Auth routes
app.post('/register', async c => {
  const authService = createAuthService(c.env);
  const authController = createAuthController(authService);
  return await authController.register(c);
});

app.post('/login', async c => {
  const authService = createAuthService(c.env);
  const authController = createAuthController(authService);
  return await authController.login(c);
});

app.post('/validate', async c => {
  const authService = createAuthService(c.env);
  const authController = createAuthController(authService);
  return await authController.validateToken(c);
});

app.post('/logout', async c => {
  const authService = createAuthService(c.env);
  const authController = createAuthController(authService);
  return await authController.logout(c);
});

// 404 handler for unknown routes
app.notFound(c => {
  getLogger().info(
    {
      path: c.req.path,
      method: c.req.method,
    },
    'Route not found',
  );

  return c.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found',
      },
    },
    404,
  );
});

// Error handler
app.onError((err, c) => {
  getLogger().error(
    {
      err,
      path: c.req.path,
      method: c.req.method,
      errorName: err.name,
      errorMessage: err.message,
      stack: err.stack,
    },
    'Unhandled error',
  );

  return c.json(
    {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal server error occurred',
      },
    },
    500,
  );
});

export default app;
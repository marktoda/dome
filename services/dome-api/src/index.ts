import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceInfo } from '@dome/common';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  createSimpleAuthMiddleware,
  formatZodError,
} from '@dome/common';
import { userIdMiddleware } from './middleware/userIdMiddleware';
import { initLogging, getLogger } from '@dome/logging';
import { metricsMiddleware, initMetrics, metrics } from './middleware/metricsMiddleware';
import type { Bindings } from './types';
import { searchController } from './controllers/searchController';
import { chatController } from './controllers/chatController';
import { siloController } from './controllers/siloController';

// Service information
const serviceInfo: ServiceInfo = {
  name: 'dome-api',
  version: '0.1.0',
  environment: 'development',
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Register middleware
// Metrics middleware (should be first to accurately measure request timing)
app.use('*', metricsMiddleware());

// Request logging middleware
app.use('*', async (c, next) => {
  const startTime = Date.now();
  getLogger().info(
    {
      path: c.req.path,
      method: c.req.method,
      userAgent: c.req.header('user-agent'),
      query: c.req.query(),
    },
    'request:start',
  );

  await next();

  const endTime = Date.now();
  const duration = endTime - startTime;

  getLogger().info(
    {
      path: c.req.path,
      method: c.req.method,
      durMs: duration,
      status: c.res.status,
    },
    'request:end',
  );
});

app.use('*', createRequestContextMiddleware());
initLogging(app, {
  extraBindings: { ...serviceInfo },
}); // Initialize logging with service info

// Initialize metrics with service info
initMetrics({
  VERSION: serviceInfo.version,
  ENVIRONMENT: serviceInfo.environment,
});

// Log application startup
getLogger().info('Application starting');
app.use('*', cors());
app.use('*', createErrorMiddleware(formatZodError));
app.use('*', createSimpleAuthMiddleware()); // Simple auth middleware for now
app.use('*', responseHandlerMiddleware);

// Root route
app.get('/', c => {
  getLogger().info({ path: '/' }, 'Root endpoint accessed');
  return c.json({
    message: 'Welcome to the dome API',
    service: serviceInfo,
    description: 'AI-Powered Exobrain API service',
  });
});

// Health check endpoint
app.get('/health', c => {
  getLogger().info({ path: '/health' }, 'Health check endpoint accessed');

  // Start a timer for the health check
  const timer = metrics.startTimer('health.check');

  // Track health check with metrics
  metrics.trackHealthCheck('ok', 0, 'api');

  // Stop the timer and get the duration
  const duration = timer.stop();

  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: serviceInfo.name,
    version: serviceInfo.version,
    metrics: {
      counters: {
        requests: metrics.getCounter('api.request'),
        errors: metrics.getCounter('api.error'),
      },
    },
  });
});

// Notes API routes
const notesRouter = new Hono();

// Apply user ID middleware to all note routes
notesRouter.use('*', userIdMiddleware);

// Ingest endpoint - for adding new notes, files, etc.
notesRouter.post('/', siloController.ingest.bind(siloController));
notesRouter.post('/upload', siloController.createUpload.bind(siloController));

// CRUD operations for notes
notesRouter.get('/:id', siloController.get.bind(siloController));
notesRouter.put('/:id', siloController.updateNote.bind(siloController));
notesRouter.delete('/:id', siloController.delete.bind(siloController));
notesRouter.get('/', siloController.listNotes.bind(siloController));

// Create a dedicated search router
const searchRouter = new Hono();

// Apply user ID middleware to all search routes
searchRouter.use('*', userIdMiddleware);

// Search endpoints - for semantic search over notes
searchRouter.get('/', searchController.search.bind(searchController));
searchRouter.get('/stream', searchController.streamSearch.bind(searchController));

// Chat API route
app.post('/chat', chatController.chat.bind(chatController));

// Mount routers
app.route('/notes', notesRouter);
app.route('/search', searchRouter);

// 404 handler for unknown routes
app.notFound(c => {
  getLogger().info(
    {
      path: c.req.path,
      method: c.req.method,
      headers: Object.fromEntries(
        [...c.req.raw.headers.entries()].filter(
          ([key]) => !key.includes('auth') && !key.includes('cookie'),
        ),
      ),
    },
    'Route not found',
  );

  // Track 404 with metrics
  metrics.counter('error.not_found', 1, {
    path: c.req.path,
    method: c.req.method,
  });

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

  // Track error with metrics
  metrics.counter('error.unhandled', 1, {
    path: c.req.path,
    method: c.req.method,
    error_type: err.name || 'Unknown',
  });

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

import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceInfo } from '@dome/common';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  createSimpleAuthMiddleware,
  formatZodError,
  createDetailedLoggerMiddleware,
} from '@dome/common';
import { userIdMiddleware, UserIdContext } from './middleware/userIdMiddleware';
import { initLogging, getLogger } from '@dome/logging';
import { metricsMiddleware, initMetrics, metrics } from './middleware/metricsMiddleware';
import type { Bindings } from './types';
import { createServiceFactory } from './services/serviceFactory';
import { createControllerFactory } from './controllers/controllerFactory';

// Service information
const serviceInfo: ServiceInfo = {
  name: 'dome-api',
  version: '0.1.0',
  environment: 'development',
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Create service and controller factories
const serviceFactory = createServiceFactory();
const controllerFactory = createControllerFactory(serviceFactory);

initLogging(app, {
  extraBindings: { ...serviceInfo },
});
app.use('*', createRequestContextMiddleware());
app.use('*', createDetailedLoggerMiddleware());
app.use('*', metricsMiddleware());

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
notesRouter.post('/', async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.ingest(c);
});

// CRUD operations for notes
notesRouter.get('/:id', async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.get(c);
});
notesRouter.put('/:id', async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.updateNote(c);
});
notesRouter.delete('/:id', async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.delete(c);
});
notesRouter.get('/', async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.listNotes(c);
});

// Create a dedicated search router
const searchRouter = new Hono();

// Apply user ID middleware to all search routes
searchRouter.use('*', userIdMiddleware);

// Search endpoints - for semantic search over notes
searchRouter.get('/', async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
  const searchController = controllerFactory.getSearchController(c.env);
  return await searchController.search(c);
});
searchRouter.get(
  '/stream',
  async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
    const searchController = controllerFactory.getSearchController(c.env);
    return await searchController.streamSearch(c);
  },
);

// Chat API route
app.post('/chat', async (c: Context<{ Bindings: Bindings }>) => {
  const chatController = controllerFactory.getChatController(c.env);
  return await chatController.chat(c);
});

// Rollout management routes have been removed as part of the Chat RAG Graph migration

// Mount routers
app.route('/notes', notesRouter);
app.route('/search', searchRouter);

// AI endpoints
const aiRouter = new Hono();
aiRouter.use('*', userIdMiddleware);

// Reprocess endpoint - for reprocessing failed AI metadata
aiRouter.post(
  '/reprocess',
  async (c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) => {
    const siloController = controllerFactory.getSiloController(c.env);
    return await siloController.reprocess(c);
  },
);

// Mount AI router
app.route('/ai', aiRouter);

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

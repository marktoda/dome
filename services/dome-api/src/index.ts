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
import type { Bindings } from './types';
import { searchController } from './controllers/searchController';
import { fileController } from './controllers/fileController';
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
// Request timing middleware
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
  extraBindings: {
    service: serviceInfo.name,
    version: serviceInfo.version,
    environment: serviceInfo.environment,
  },
}); // Initialize logging with service info

// Log application startup
getLogger().info(
  {
    service: serviceInfo.name,
    version: serviceInfo.version,
    environment: serviceInfo.environment,
  },
  'Application starting',
);
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
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: serviceInfo.name,
    version: serviceInfo.version,
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

// Search endpoints - for semantic search over notes
notesRouter.get('/search', searchController.search.bind(searchController));
notesRouter.get('/search/stream', searchController.streamSearch.bind(searchController));

// Chat API route
app.post('/chat', chatController.chat.bind(chatController));

// Mount routers
app.route('/notes', notesRouter);

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

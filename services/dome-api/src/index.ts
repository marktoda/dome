import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { ServiceInfo } from '@dome/common';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  createPinoLoggerMiddleware,
  createSimpleAuthMiddleware,
  formatZodError,
  NotImplementedError
} from '@dome/common';
import type { Bindings } from './types';
import { SearchController } from './controllers/searchController';
import { fileController } from './controllers/fileController';

// Service information
const serviceInfo: ServiceInfo = {
  name: 'dome-api',
  version: '0.1.0',
  environment: 'development',
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Register middleware
app.use('*', createRequestContextMiddleware());
app.use('*', createPinoLoggerMiddleware());
app.use('*', cors());
app.use('*', createErrorMiddleware(formatZodError));
app.use('*', createSimpleAuthMiddleware()); // Simple auth middleware for now
app.use('*', responseHandlerMiddleware);

// Root route
app.get('/', (c) =>
  c.json({
    message: 'Welcome to the dome API',
    service: serviceInfo,
    description: 'AI-Powered Exobrain API service',
  }),
);

// Health check endpoint
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: serviceInfo.name,
    version: serviceInfo.version,
  }),
);

// Notes API routes
const notesRouter = new Hono();

// Ingest endpoint - for adding new notes, files, etc.
notesRouter.post('/ingest', async (c) => {
  throw new NotImplementedError('Notes ingestion not implemented yet');
});

// File attachment endpoints
notesRouter.post('/files', fileController.uploadFile.bind(fileController));
notesRouter.get('/:id/file', fileController.getFileAttachment.bind(fileController));
notesRouter.post('/:id/process-file', fileController.processFileContent.bind(fileController));
notesRouter.delete('/:id/file', fileController.deleteFileAttachment.bind(fileController));

// Search endpoint - for semantic search over notes
notesRouter.get('/search', SearchController.search);

// Streaming search endpoint - for real-time search results
notesRouter.get('/search/stream', SearchController.streamSearch);

// Tasks API routes
const tasksRouter = new Hono();

// Create task
tasksRouter.post('/', async (c) => {
  throw new NotImplementedError('Task creation not implemented yet');
});

// List tasks
tasksRouter.get('/', async (c) => {
  throw new NotImplementedError('Task listing not implemented yet');
});

// Complete task
tasksRouter.post('/:id/complete', async (c) => {
  throw new NotImplementedError('Task completion not implemented yet');
});

// Chat API route
app.post('/chat', async (c) => {
  throw new NotImplementedError('Chat functionality not implemented yet');
});

// Mount routers
app.route('/notes', notesRouter);
app.route('/tasks', tasksRouter);

// 404 handler for unknown routes
app.notFound((c) => {
  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found',
    }
  }, 404);
});

export default app;

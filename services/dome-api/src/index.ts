import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { ServiceInfo } from '@dome/common';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  createSimpleAuthMiddleware,
  formatZodError,
  NotImplementedError
} from '@dome/common';
import { initLogging, getLogger } from '@dome/logging';
import type { Bindings } from './types';
import { SearchController } from './controllers/searchController';
import { fileController } from './controllers/fileController';
import { noteController } from './controllers/noteController';
import { taskController } from './controllers/taskController';
import { chatController } from './controllers/chatController';

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
initLogging(app, {
  extraBindings: {
    service: serviceInfo.name,
    version: serviceInfo.version,
    environment: serviceInfo.environment
  }
}); // Initialize logging with service info

// Log application startup
getLogger().info(
  {
    service: serviceInfo.name,
    version: serviceInfo.version,
    environment: serviceInfo.environment
  },
  'Application starting'
);
app.use('*', cors());
app.use('*', createErrorMiddleware(formatZodError));
app.use('*', createSimpleAuthMiddleware()); // Simple auth middleware for now
app.use('*', responseHandlerMiddleware);

// Root route
app.get('/', (c) => {
  getLogger().info({ path: '/' }, 'Root endpoint accessed');
  return c.json({
    message: 'Welcome to the dome API',
    service: serviceInfo,
    description: 'AI-Powered Exobrain API service',
  });
});

// Health check endpoint
app.get('/health', (c) => {
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

// Ingest endpoint - for adding new notes, files, etc.
notesRouter.post('/ingest', noteController.ingest.bind(noteController));

// CRUD operations for notes
notesRouter.get('/', noteController.listNotes.bind(noteController));
notesRouter.get('/:id', noteController.getNote.bind(noteController));
notesRouter.put('/:id', noteController.updateNote.bind(noteController));
notesRouter.delete('/:id', noteController.deleteNote.bind(noteController));

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

// CRUD operations for tasks
tasksRouter.post('/', taskController.createTask.bind(taskController));
tasksRouter.get('/', taskController.listTasks.bind(taskController));
tasksRouter.get('/:id', taskController.getTask.bind(taskController));
tasksRouter.put('/:id', taskController.updateTask.bind(taskController));
tasksRouter.delete('/:id', taskController.deleteTask.bind(taskController));

// Complete task
tasksRouter.post('/:id/complete', taskController.completeTask.bind(taskController));

// Add reminder to task
tasksRouter.post('/:id/remind', taskController.addReminder.bind(taskController));

// Chat API route
app.post('/chat', chatController.chat.bind(chatController));

// Mount routers
app.route('/notes', notesRouter);
app.route('/tasks', tasksRouter);

// Request timing middleware
app.use('*', async (c, next) => {
  const startTime = Date.now();
  getLogger().info({
    path: c.req.path,
    method: c.req.method,
    userAgent: c.req.header('user-agent'),
    query: c.req.query()
  }, 'request:start');
  
  await next();
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  getLogger().info({
    path: c.req.path,
    method: c.req.method,
    durMs: duration,
    status: c.res.status
  }, 'request:end');
});

// 404 handler for unknown routes
app.notFound((c) => {
  getLogger().info({
    path: c.req.path,
    method: c.req.method,
    headers: Object.fromEntries([...c.req.raw.headers.entries()].filter(([key]) => !key.includes('auth') && !key.includes('cookie')))
  }, 'Route not found');
  
  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found',
    }
  }, 404);
});

// Error handler
app.onError((err, c) => {
  getLogger().error({
    err,
    path: c.req.path,
    method: c.req.method,
    errorName: err.name,
    errorMessage: err.message,
    stack: err.stack
  }, 'Unhandled error');
  
  return c.json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An internal server error occurred',
    }
  }, 500);
});

export default app;

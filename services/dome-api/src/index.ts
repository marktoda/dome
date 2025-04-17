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

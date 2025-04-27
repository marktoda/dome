import { Hono, Context } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors';
import type { ServiceInfo } from '@dome/common';
import { chatRequestSchema } from '@dome/chat/client';
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


app.get(
  '/chat',                     // public endpoint -> wss://api.example.com/v1/chat
  upgradeWebSocket((c) => {
    // NB: Cloudflare Workers has no `onOpen`; first client frame is where we start
    return {
      async onMessage(event, ws) {
        try {
          const chatService = serviceFactory.getChatService(c.env);
          
          // Parse the incoming data as JSON if it's a string
          let jsonData;
          if (typeof event.data === 'string') {
            try {
              jsonData = JSON.parse(event.data);
              getLogger().debug('Successfully parsed WebSocket message as JSON');
            } catch (parseError) {
              getLogger().error({ error: parseError }, 'Failed to parse WebSocket message as JSON');
              ws.send('Error: Invalid JSON payload');
              ws.close(1008, 'Invalid JSON payload');
              return;
            }
          } else {
            jsonData = event.data;
          }
          
          // Validate against the Zod schema
          try {
            // Ensure userId is present
            if (!jsonData.userId) {
              jsonData.userId = 'test-user-id'; // Default for CLI
            }
            
            // Parse with Zod schema
            const validatedRequest = chatRequestSchema.parse(jsonData);
            getLogger().info({
              req: validatedRequest,
              op: 'startChatSession'
            }, 'ChatController request');
            
            const resp = await chatService.streamResponse(validatedRequest);
            
            // Pump the streaming body into the socket
            const reader = resp.body!.getReader()
            const td = new TextDecoder()
            
            while (true) {
              const { value, done } = await reader.read()
              getLogger().debug({ value }, 'streaming response')
              if (done) break
              ws.send(td.decode(value))   // send LangGraph chunk to the client
            }
            ws.close()                    // tell the client we're done
          } catch (zodError) {
            getLogger().error({ error: zodError }, 'Zod validation error for WebSocket message');
            const errorMessage = zodError instanceof Error ?
              zodError.message :
              'Unknown validation error';
            ws.send(`Error: Invalid request format - ${errorMessage}`);
            ws.close(1007, 'Invalid message format');
          }
        } catch (error) {
          getLogger().error({ error }, 'Error processing WebSocket message');
          ws.send(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
          ws.close(1011, 'Internal server error');
        }
      },

      onClose() {
        /* metrics / cleanup */
      },

      onError(err) {
        console.error('ws error', err)
      },
    }
  }),
)

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

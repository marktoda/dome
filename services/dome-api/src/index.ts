import { Hono, Context } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { cors } from 'hono/cors';
import type { ServiceInfo } from '@dome/common';
import { chatRequestSchema } from '@dome/chat/client';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  formatZodError,
  createDetailedLoggerMiddleware,
} from '@dome/common';
import { authenticationMiddleware, AuthContext } from './middleware/authenticationMiddleware';
import { createAuthController } from './controllers/authController';
import { initLogging, getLogger } from '@dome/common';
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
// Replace simple auth with auth routes and protected route middleware
app.use('*', responseHandlerMiddleware);

// Auth routes (no authentication required)
const authRouter = new Hono();

authRouter.post('/login', async (c: Context<{ Bindings: Bindings }>) => {
  const authController = createAuthController();
  return await authController.login(c);
});

authRouter.post('/register', async (c: Context<{ Bindings: Bindings }>) => {
  const authController = createAuthController();
  return await authController.register(c);
});

authRouter.post('/validate', async (c: Context<{ Bindings: Bindings }>) => {
  const authController = createAuthController();
  return await authController.validateToken(c);
});

authRouter.post('/logout', async (c: Context<{ Bindings: Bindings }>) => {
  const authController = createAuthController();
  return await authController.logout(c);
});

// Mount auth router
app.route('/auth', authRouter);

// Public routes (no authentication required)
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

// Notes API routes - protected by authentication
const notesRouter = new Hono();

// Apply authentication middleware to all note routes
notesRouter.use('*', authenticationMiddleware);

// Ingest endpoint - for adding new notes, files, etc.
notesRouter.post('/', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.ingest(c);
});

// CRUD operations for notes
notesRouter.get('/:id', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.get(c);
});
notesRouter.put('/:id', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.updateNote(c);
});
notesRouter.delete('/:id', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.delete(c);
});
notesRouter.get('/', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.listNotes(c);
});

// Create a dedicated search router - protected by authentication
const searchRouter = new Hono();

// Apply authentication middleware to all search routes
searchRouter.use('*', authenticationMiddleware);

// Search endpoints - for semantic search over notes
searchRouter.get('/', async (c: Context<{ Bindings: Bindings }>) => {
  const searchController = controllerFactory.getSearchController(c.env);
  return await searchController.search(c);
});
searchRouter.get('/stream', async (c: Context<{ Bindings: Bindings }>) => {
  const searchController = controllerFactory.getSearchController(c.env);
  return await searchController.streamSearch(c);
});

// Chat API routes - protected by authentication
const chatRouter = new Hono();
// REMOVED: chatRouter.use('*', authenticationMiddleware);

// Apply authenticationMiddleware specifically to the POST /chat route
chatRouter.post('/', authenticationMiddleware, async (c: Context<{ Bindings: Bindings }>) => {
  const chatController = controllerFactory.getChatController(c.env);
  return await chatController.chat(c);
});

// Mount chat router
app.route('/chat', chatRouter);

// WebSocket chat endpoint
app.get(
  '/chat/ws', // WebSocket endpoint
  upgradeWebSocket(c => {
    // NB: Cloudflare Workers has no `onOpen`; first client frame is where we start
    return {
      async onMessage(event, ws) {
        const logger = getLogger().child({
          component: 'WebSocketChatHandler',
          requestId: Math.random().toString(36).substring(2, 12),
        });

        try {
          const chatService = serviceFactory.getChatService(c.env);
          const authService = serviceFactory.getAuthService(c.env);

          // Parse the incoming data as JSON if it's a string
          let jsonData;
          if (typeof event.data === 'string') {
            try {
              jsonData = JSON.parse(event.data);
              logger.debug('Successfully parsed WebSocket message as JSON');
            } catch (parseError) {
              logger.error({ error: parseError }, 'Failed to parse WebSocket message as JSON');
              ws.send('Error: Invalid JSON payload');
              ws.close(1008, 'Invalid JSON payload');
              return;
            }
          } else {
            jsonData = event.data;
          }

          logger.debug({ jsonData }, 'Received WebSocket message');

          // Validate authentication
          let authenticatedUserId;

          // Get token from various possible locations
          const token =
            jsonData.token || (jsonData.auth && jsonData.auth.token ? jsonData.auth.token : null);

          logger.debug(
            {
              hasToken: !!token,
              hasAuthObject: !!jsonData.auth,
              hasAuthToken: jsonData.auth && !!jsonData.auth.token,
              providedUserId: jsonData.userId || '[none]',
            },
            'WebSocket auth details',
          );

          if (token) {
            // If token is provided, validate it
            const authResult = await authService.validateToken(token);
            logger.info({ authResult }, 'WebSocket auth validation result');

            if (authResult.success && authResult.user) {
              authenticatedUserId = authResult.user.id;
              logger.info(
                { authenticatedUserId },
                'Successfully authenticated WebSocket connection',
              );
            } else {
              logger.warn('Invalid auth token in WebSocket connection');
              ws.send('Error: Authentication failed - invalid token');
              ws.close(1008, 'Authentication failed');
              return;
            }
          } else {
            // For compatibility with older clients, allow CLI testing with a specific user ID
            // ONLY IN DEVELOPMENT ENVIRONMENT
            const isDevelopment = c.env.ENVIRONMENT === 'development';

            if (isDevelopment && jsonData.userId === 'test-user-id') {
              logger.warn('Using test user ID in development environment');
              authenticatedUserId = 'test-user-id';
            } else {
              logger.warn('Missing authentication token in WebSocket connection');
              ws.send('Error: Authentication required');
              ws.close(1008, 'Authentication required');
              return;
            }
          }

          // Override any user ID in the request with the authenticated one
          jsonData.userId = authenticatedUserId;

          // Parse with Zod schema
          const validatedRequest = chatRequestSchema.parse(jsonData);
          logger.info(
            {
              userId: authenticatedUserId,
              req: {
                ...validatedRequest,
                // Don't log potential sensitive content
                messages: validatedRequest.messages
                  ? `${validatedRequest.messages.length} messages`
                  : 'none',
              },
              op: 'startChatSession',
            },
            'ChatController WebSocket request',
          );

          const resp = await chatService.streamResponse(validatedRequest);

          // Pump the streaming body into the socket
          const reader = resp.body!.getReader();
          const td = new TextDecoder();

          while (true) {
            const { value, done } = await reader.read();
            getLogger().debug({ value }, 'streaming response');
            if (done) break;
            ws.send(td.decode(value)); // send LangGraph chunk to the client
          }
          ws.close(); // tell the client we're done
        } catch (error: unknown) {
          // Handle different error types
          if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') {
            getLogger().error({ error }, 'Zod validation error for WebSocket message');
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown validation error';
            ws.send(`Error: Invalid request format - ${errorMessage}`);
            ws.close(1007, 'Invalid message format');
          } else {
            getLogger().error({ error }, 'Error processing WebSocket message');
            ws.send(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            ws.close(1011, 'Internal server error');
          }
        }
      },

      onClose() {
        /* metrics / cleanup */
      },

      onError(err) {
        console.error('ws error', err);
      },
    };
  }),
);

// Rollout management routes have been removed as part of the Chat RAG Graph migration

// Mount routers
app.route('/notes', notesRouter);
app.route('/search', searchRouter);

const contentRouter = new Hono();
contentRouter.use('*', authenticationMiddleware);

// Register a GitHub repository
contentRouter.post('/github', async (c: Context<{ Bindings: Bindings }>) => {
  const tsunamiController = controllerFactory.getTsunamiController(c.env);
  return await tsunamiController.registerGithubRepo(c);
});

// Get GitHub repository history
contentRouter.get('/github/:owner/:repo/history', async (c: Context<{ Bindings: Bindings }>) => {
  const tsunamiController = controllerFactory.getTsunamiController(c.env);
  return await tsunamiController.getGithubRepoHistory(c);
});

// Get user sync history
contentRouter.get('/sync/user/:userId/history', async (c: Context<{ Bindings: Bindings }>) => {
  const tsunamiController = controllerFactory.getTsunamiController(c.env);
  return await tsunamiController.getUserHistory(c);
});

// Get sync plan history
contentRouter.get('/sync/plan/:syncPlanId/history', async (c: Context<{ Bindings: Bindings }>) => {
  const tsunamiController = controllerFactory.getTsunamiController(c.env);
  return await tsunamiController.getSyncPlanHistory(c);
});

// Notion workspace registration and management
contentRouter.post('/notion', async (c: Context<{ Bindings: Bindings }>) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.registerNotionWorkspace(c);
});

// Get Notion workspace history
contentRouter.get('/notion/:workspaceId/history', async (c: Context<{ Bindings: Bindings }>) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.getNotionWorkspaceHistory(c);
});

// Trigger Notion workspace sync
contentRouter.post('/notion/:workspaceId/sync', async (c: Context<{ Bindings: Bindings }>) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.triggerNotionWorkspaceSync(c);
});

// Notion OAuth configuration
contentRouter.post('/notion/oauth', async (c: Context<{ Bindings: Bindings }>) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.configureNotionOAuth(c);
});

// Get Notion OAuth URL
contentRouter.get('/notion/oauth/url', async (c: Context<{ Bindings: Bindings }>) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.getNotionOAuthUrl(c);
});

// Store Notion OAuth integration details (token, workspace info)
contentRouter.post('/notion/oauth/store', async (c: Context<{ Bindings: Bindings }>) => {
  const notionController = controllerFactory.getNotionController(c.env);
  return await notionController.storeNotionIntegration(c);
});

// Store GitHub OAuth integration details
contentRouter.post('/github/oauth/store', async (c: Context<{ Bindings: Bindings }>) => {
  const tsunamiController = controllerFactory.getTsunamiController(c.env); // Assuming TsunamiController handles this
  return await tsunamiController.storeGithubIntegration(c);
});

// Mount GitHub router under content path
app.route('/content', contentRouter);

// AI endpoints - protected by authentication
const aiRouter = new Hono();
aiRouter.use('*', authenticationMiddleware);

// Reprocess endpoint - for reprocessing failed AI metadata
aiRouter.post('/reprocess', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.reprocess(c);
});

// Bulk reprocess endpoint - for reprocessing multiple content items by IDs
aiRouter.post('/bulk-reprocess', async (c: Context<{ Bindings: Bindings }>) => {
  const siloController = controllerFactory.getSiloController(c.env);
  return await siloController.bulkReprocess(c);
});

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

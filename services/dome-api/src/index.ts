import { Hono, Context } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono } from '@hono/zod-openapi';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import type { WSContext, WSEvents } from 'hono/ws';
import { HTTPException } from 'hono/http-exception';
import { cors } from 'hono/cors';
import type { ServiceInfo } from '@dome/common';
import { chatRequestSchema } from '@dome/chat/client';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  formatZodError,
  createDetailedLoggerMiddleware,
  updateContext,
} from '@dome/common';
import { authenticationMiddleware, AuthContext } from './middleware/authenticationMiddleware';
import { buildAuthRouter } from './controllers/authController';
import { buildNotesRouter, buildAiRouter } from './controllers/siloController'; // Import new router builders
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
const app = new OpenAPIHono<{ Bindings: Bindings }>();

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

// Register global security schemes with the OpenAPI registry
app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT', // Optional but good for documentation
  description:
    'JWT Authorization header using the Bearer scheme. Example: "Authorization: Bearer {token}"',
});

// Mount auth router
app.route('/auth', buildAuthRouter());

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
  upgradeWebSocket(async (c): Promise<Omit<WSEvents<WebSocket>, 'onOpen'>> => {
    const logger = getLogger().child({
      component: 'WebSocketUpgradeHandler',
      requestId: c.get('requestId') || Math.random().toString(36).substring(2, 12),
    });

    const token = c.req.query('token');
    const authService = serviceFactory.getAuthService(c.env);

    if (!token) {
      logger.warn('Missing token in WebSocket upgrade request query parameters.');
      throw new HTTPException(401, {
        message: 'Authentication token missing in query.',
        cause: {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication token missing in query.' },
        },
      });
    }

    const authResult = await authService.validateToken(token);
    logger.info({ authResult }, 'WebSocket upgrade auth validation result');

    if (!authResult.success || !authResult.user) {
      logger.warn('Invalid token in WebSocket upgrade request.');
      throw new HTTPException(401, {
        message: 'Invalid or expired token for WebSocket.',
        cause: {
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token for WebSocket.' },
        },
      });
    }

    const authenticatedUserId = authResult.user.id;
    // Update context for subsequent logging within this request scope if possible,
    // though this context is primarily for HTTP. For WebSocket messages, pass userId.
    await updateContext({
      identity: {
        userId: authResult.user.id,
        role: authResult.user.role,
        email: authResult.user.email,
      },
    });
    logger.info({ authenticatedUserId }, 'Successfully authenticated WebSocket upgrade request.');

    // NB: Cloudflare Workers has no `onOpen`; first client frame is where we start
    return {
      async onMessage(event: MessageEvent, ws: WSContext) {
        // Use a logger specific to this message handling, potentially with the authenticatedUserId
        const messageLogger = getLogger().child({
          component: 'WebSocketChatHandler',
          requestId: c.get('requestId') || Math.random().toString(36).substring(2, 12), // Reuse or generate new
          authenticatedUserId, // Log with authenticated user
        });

        try {
          const chatService = serviceFactory.getChatService(c.env);

          // Parse the incoming data as JSON if it's a string
          let jsonData;
          if (typeof event.data === 'string') {
            try {
              jsonData = JSON.parse(event.data);
              messageLogger.debug('Successfully parsed WebSocket message as JSON');
            } catch (parseError) {
              messageLogger.error(
                { error: parseError },
                'Failed to parse WebSocket message as JSON',
              );
              ws.send(
                JSON.stringify({
                  type: 'error',
                  error: { message: 'Invalid JSON payload', code: 'INVALID_PAYLOAD' },
                }),
              );
              // Consider closing if payload is critical: ws.close(1007, 'Invalid JSON payload');
              return;
            }
          } else {
            // Assuming binary data is not expected or handled differently
            messageLogger.warn('Received non-string WebSocket message, ignoring.');
            ws.send(
              JSON.stringify({
                type: 'error',
                error: {
                  message: 'Unsupported message format (expected JSON string)',
                  code: 'UNSUPPORTED_FORMAT',
                },
              }),
            );
            return;
          }

          messageLogger.debug({ jsonData }, 'Received WebSocket message');

          // Set the authenticated user ID from the upgrade handshake
          // The token is no longer expected in the message payload itself.
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
            messageLogger.debug(
              { value: td.decode(value, { stream: true }) },
              'streaming response chunk',
            );
            if (done) break;
            ws.send(td.decode(value)); // send LangGraph chunk to the client
          }
          messageLogger.info('Finished streaming response to WebSocket.');
          // ws.close(); // LangGraph stream or chatService should signal end of interaction.
          // The client might keep the connection open for further messages or the server might close it after a timeout.
          // For now, let's assume the stream itself signals completion and the client might send more.
          // If it's a one-shot stream, then ws.close() here or after stream is appropriate.
        } catch (error: unknown) {
          messageLogger.error({ error }, 'Error processing WebSocket message');
          let errorCode = 'INTERNAL_SERVER_ERROR';
          let errorMessage = 'An internal server error occurred.';
          let closeCode = 1011; // Internal error

          if (error && typeof error === 'object' && 'name' in error && error.name === 'ZodError') {
            errorCode = 'VALIDATION_ERROR';
            errorMessage = `Invalid request format: ${error instanceof Error ? error.message : 'Unknown validation error'
              }`;
            closeCode = 1007; // Invalid message format
          } else if (error instanceof Error) {
            errorMessage = error.message;
          }

          try {
            ws.send(
              JSON.stringify({ type: 'error', error: { message: errorMessage, code: errorCode } }),
            );
            if (ws.readyState === WebSocket.OPEN) {
              // ws.close(closeCode, errorMessage.substring(0, 123)); // Max length for reason is 123 bytes
            }
          } catch (sendError) {
            messageLogger.error({ sendError }, 'Failed to send error message over WebSocket.');
          }
        }
      },

      onClose(event: CloseEvent, ws: WSContext) {
        const closeLogger = getLogger().child({
          component: 'WebSocketChatHandler',
          requestId: c.get('requestId') || 'N/A',
          authenticatedUserId: authenticatedUserId || 'N/A',
        });
        closeLogger.info(
          { code: event.code, reason: event.reason, wasClean: event.wasClean },
          'WebSocket connection closed.',
        );
        /* metrics / cleanup */
      },

      onError(event: Event, ws: WSContext) {
        // Added ws: WSContext as per WSEvents, though not used in current impl.
        const errorLogger = getLogger().child({
          component: 'WebSocketChatHandler',
          requestId: c.get('requestId') || 'N/A',
          authenticatedUserId: authenticatedUserId || 'N/A', // Ensure authenticatedUserId is accessible
        });
        errorLogger.error({ error: event }, 'WebSocket error event triggered.');
      },
    };
  }),
);

// Rollout management routes have been removed as part of the Chat RAG Graph migration

// Mount routers
app.route('/notes', buildNotesRouter()); // Use the new OpenAPI-enabled router
app.route('/search', searchRouter); // searchRouter migration is a separate task

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
// The aiRouter is now an OpenAPIHono instance built by buildAiRouter
// It already includes authentication middleware and OpenAPI route definitions for reprocess/bulkReprocess.
// const aiRouter = new Hono(); // Old way
// aiRouter.use('*', authenticationMiddleware); // Old way
// ... old manual AI route definitions removed ...

// Mount AI router
app.route('/ai', buildAiRouter()); // Use the new OpenAPI-enabled router for AI

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

// Serve the OpenAPI JSON specification
// Routes and registered components (like securitySchemes) will be automatically included.
app.doc('/openapi.json', {
  openapi: '3.0.3',
  info: {
    title: `${serviceInfo.name} API`,
    version: serviceInfo.version,
    description: `API for ${serviceInfo.name} services. Environment: ${serviceInfo.environment}.`,
  },
  servers: [{ url: '/', description: `Current environment (${serviceInfo.environment})` }],
});

// Serve Swagger UI
app.get('/docs', swaggerUI({ url: '/openapi.json', title: `${serviceInfo.name} API Docs` }));

export default app;

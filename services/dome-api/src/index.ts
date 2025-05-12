import { Hono, Context } from 'hono';
import { swaggerUI } from '@hono/swagger-ui';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi'; // Added createRoute
import { z } from 'zod'; // Added z
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
import { buildNotesRouter, buildAiRouter } from './controllers/siloController';
import { buildTsunamiContentRouter } from './controllers/tsunamiController';
import { buildNotionContentRouter } from './controllers/notionController';
import { buildSearchRouter } from './controllers/searchController';
import { buildChatRouter } from './controllers/chatController'; // Import Chat router builder
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

// --- Public Routes (OpenAPI) ---

// Schemas for Public Routes
const RootResponseSchema = z.object({
  message: z.string().openapi({ example: 'Welcome to the dome API' }),
  service: z.object({
    name: z.string().openapi({ example: serviceInfo.name }),
    version: z.string().openapi({ example: serviceInfo.version }),
    environment: z.string().openapi({ example: serviceInfo.environment }),
  }),
  description: z.string().openapi({ example: 'AI-Powered Exobrain API service' }),
}).openapi('RootResponse');

const HealthResponseSchema = z.object({
  status: z.literal('ok').openapi({ example: 'ok' }),
  timestamp: z.string().datetime().openapi({ example: new Date().toISOString() }),
  service: z.string().openapi({ example: serviceInfo.name }),
  version: z.string().openapi({ example: serviceInfo.version }),
  metrics: z.object({
    counters: z.object({
      requests: z.number().int().optional().openapi({ example: 100 }),
      errors: z.number().int().optional().openapi({ example: 5 }),
    }),
  }).optional(),
}).openapi('HealthResponse');

// Route Definitions for Public Routes
const rootRoute = createRoute({
  method: 'get',
  path: '/',
  summary: 'API Root',
  description: 'Provides basic information about the API service.',
  responses: {
    200: {
      description: 'Service information.',
      content: { 'application/json': { schema: RootResponseSchema } },
    },
  },
  tags: ['Public'],
});

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  summary: 'Health Check',
  description: 'Checks the health status of the API service.',
  responses: {
    200: {
      description: 'Service is healthy.',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
  tags: ['Public'],
});

// Register Public Routes
app.openapi(rootRoute, c => {
  getLogger().info({ path: '/' }, 'Root endpoint accessed');
  return c.json({
    message: 'Welcome to the dome API',
    service: serviceInfo,
    description: 'AI-Powered Exobrain API service',
  }, 200);
});

app.openapi(healthRoute, c => {
  getLogger().info({ path: '/health' }, 'Health check endpoint accessed');
  const timer = metrics.startTimer('health.check');
  metrics.trackHealthCheck('ok', 0, 'api');
  const duration = timer.stop(); // duration is not part of schema, but good to keep calculation
  return c.json({
    status: 'ok' as const, // Ensure 'ok' is treated as a literal type
    timestamp: new Date().toISOString(),
    service: serviceInfo.name,
    version: serviceInfo.version,
    metrics: { // Optional in schema, provide if available
      counters: {
        requests: metrics.getCounter('api.request'),
        errors: metrics.getCounter('api.error'),
      },
    },
  }, 200);
});

// --- Chat Routes ---

// OpenAPI definition for the WebSocket handshake
const ChatWsUpgradeQuerySchema = z.object({
  token: z.string().optional().openapi({
    param: { name: 'token', in: 'query' },
    description: 'Authentication token for WebSocket upgrade.',
    example: 'jwt_token_here',
  }),
});

const chatWsUpgradeRoute = createRoute({
  method: 'get',
  path: '/chat/ws',
  summary: 'Upgrade to WebSocket for Chat',
  description:
    'Initiates a WebSocket connection for real-time chat. Requires a valid authentication token as a query parameter. ' +
    'Upon successful upgrade, the protocol switches to WebSocket. Messages over WebSocket should follow the documented format (e.g., JSON with type and payload).',
  request: {
    query: ChatWsUpgradeQuerySchema,
  },
  responses: {
    101: {
      description: 'Switching Protocols. Connection will be upgraded to WebSocket.',
      // No content schema for 101 typically, but headers might be relevant if specified.
    },
    401: {
      description: 'Unauthorized. Token missing or invalid.',
      content: { 'application/json': { schema: z.object({ success: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }) } } // Generic error
    },
  },
  tags: ['Chat', 'WebSocket'],
});

// Register the OpenAPI documentation for the WS handshake
// The actual WebSocket handling is done by the app.get('/chat/ws', upgradeWebSocket(...)) below.
// This openapi route handler doesn't need to do much, as `upgradeWebSocket` takes over.
app.openapi(chatWsUpgradeRoute, (c) => {
  // This handler is primarily for OpenAPI documentation generation.
  // The actual WebSocket upgrade is handled by the `app.get('/chat/ws', upgradeWebSocket(...))` below.
  // If the token is invalid, `upgradeWebSocket`'s logic will throw an HTTPException (resulting in a 401).
  // If the token is valid and upgrade is successful, a 101 response is sent by the WebSocket handler.
  // This openapi route handler is primarily for documentation.
  // Returning c.res allows the subsequent app.get('/chat/ws', upgradeWebSocket(...)) to handle the response.
  // The OpenAPI spec defines that a 101 is expected.
  return c.res;
});


// Mount new OpenAPI-based Chat router for POST /chat
app.route('/chat', buildChatRouter());

// WebSocket chat endpoint (actual handler)
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

    const authResult = await authService.validateToken(token, "privy");
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
    // Update context for subsequent logging within this request scope if possible
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

// Instantiate SearchController using the factory.
// `buildSearchRouter` now creates its own SearchController instance.
app.route('/search', buildSearchRouter()); // Mount new Search router

// Mount the new Tsunami-specific parts of the content router
app.route('/content', buildTsunamiContentRouter()); // Mount Tsunami routes at /content/...
// Mount the new Notion-specific parts of the content router under a /content/notion prefix
app.route('/content/notion', buildNotionContentRouter()); // Mount Notion routes at /content/notion/...

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



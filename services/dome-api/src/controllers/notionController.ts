import { Context } from 'hono';
import { z, createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { getLogger, logError } from '@dome/common';
import { createServiceFactory } from '../services/serviceFactory';
import type { AppEnv } from '../types';
import { authenticationMiddleware, AuthContext } from '../middleware/authenticationMiddleware'; // Assuming auth is needed

const logger = getLogger().child({ component: 'NotionController' });

// --- Generic Error Schema (can be shared or defined per controller) ---
const ErrorDetailSchema = z.object({
  code: z.string().openapi({ example: 'NOT_FOUND' }),
  message: z.string().openapi({ example: 'Resource not found' }),
});
const ErrorResponseSchema = z.object({
  success: z.literal(false).openapi({ example: false }),
  error: ErrorDetailSchema,
}).openapi('NotionErrorResponse'); // Unique name for OpenAPI spec

// --- Parameter Schemas ---
const WorkspaceIdParamSchema = z.object({
  workspaceId: z.string().openapi({ param: { name: 'workspaceId', in: 'path' }, example: 'notion_ws_123' }),
});

// --- Body Schemas ---
const RegisterNotionWorkspaceBodySchema = z.object({
  // Assuming some details are needed, e.g., an access token or initial setup info
  // This will depend on how Notion integration is initiated.
  // For now, let's assume it might take an initial token or bot ID.
  botId: z.string().optional().openapi({ example: 'abc-123-def-456' }),
  accessToken: z.string().optional().openapi({ example: 'secret_...' }),
  workspaceName: z.string().optional().openapi({ example: 'My Team Workspace' }),
}).openapi('RegisterNotionWorkspaceBody');

const ConfigureNotionOAuthBodySchema = z.object({
  // This endpoint might be for internal setup, or could be deprecated
  // if the flow is client_id -> /url -> /store
  clientId: z.string().optional().openapi({ example: 'oauth_client_id_...' }),
  clientSecret: z.string().optional().openapi({ example: 'oauth_client_secret_...' }),
  redirectUri: z.string().url().optional().openapi({ example: 'https://myapp.com/oauth/callback/notion' }),
}).openapi('ConfigureNotionOAuthBody');

const StoreNotionIntegrationBodySchema = z.object({
  code: z.string().openapi({ example: 'auth_code_from_notion' }), // Authorization code from Notion OAuth
  state: z.string().optional().openapi({ example: 'csrf_state_token' }), // Optional CSRF state
  // Potentially installation_id or workspace_id if Notion provides it directly here
}).openapi('StoreNotionIntegrationBody');


// --- Response Schemas ---
const NotionWorkspaceResponseSchema = z.object({
  id: z.string().openapi({ example: 'notion_ws_123' }),
  name: z.string().openapi({ example: 'My Team Workspace' }),
  // other relevant fields
}).openapi('NotionWorkspaceResponse');

const NotionSyncHistoryItemSchema = z.object({
  id: z.string().openapi({ example: 'sync_hist_notion_abc' }),
  timestamp: z.string().datetime().openapi({ example: new Date().toISOString() }),
  status: z.string().openapi({ example: 'SUCCESS' }),
  details: z.string().optional().openapi({ example: 'Synced 50 pages.' }),
}).openapi('NotionSyncHistoryItem');
const NotionSyncHistoryResponseSchema = z.array(NotionSyncHistoryItemSchema).openapi('NotionSyncHistoryResponse');

const NotionOAuthUrlResponseSchema = z.object({
  url: z.string().url().openapi({ example: 'https://api.notion.com/v1/oauth/authorize?client_id=...' }),
}).openapi('NotionOAuthUrlResponse');

const GenericSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
}).openapi('NotionGenericSuccessResponse'); // Unique name

// --- Route Definitions ---

// POST /notion - Register Notion Workspace
const registerNotionWorkspaceRoute = createRoute({
  method: 'post', path: '/', summary: 'Register Notion Workspace', security: [{ BearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: RegisterNotionWorkspaceBodySchema } }, required: true } },
  responses: {
    201: { description: 'Workspace registered.', content: { 'application/json': { schema: NotionWorkspaceResponseSchema } } },
    400: { description: 'Bad Request.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Notion'],
});

// GET /notion/:workspaceId/history - Get Notion Workspace Sync History
const getNotionWorkspaceHistoryRoute = createRoute({
  method: 'get', path: '/{workspaceId}/history', summary: 'Get Notion Workspace Sync History', security: [{ BearerAuth: [] }],
  request: { params: WorkspaceIdParamSchema },
  responses: {
    200: { description: 'Sync history.', content: { 'application/json': { schema: NotionSyncHistoryResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Not Found.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Notion'],
});

// POST /notion/:workspaceId/sync - Trigger Notion Workspace Sync
const triggerNotionWorkspaceSyncRoute = createRoute({
  method: 'post', path: '/{workspaceId}/sync', summary: 'Trigger Notion Workspace Sync', security: [{ BearerAuth: [] }],
  request: { params: WorkspaceIdParamSchema }, // No body expected, just trigger
  responses: {
    202: { description: 'Sync triggered.', content: { 'application/json': { schema: GenericSuccessResponseSchema } } }, // 202 Accepted
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Not Found.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Notion'],
});

// POST /notion/oauth - Configure Notion OAuth (Potentially internal or admin)
const configureNotionOAuthRoute = createRoute({
  method: 'post', path: '/oauth/configure', // Changed path to avoid conflict with /oauth/store or /oauth/url
  summary: 'Configure Notion OAuth Credentials (Internal/Admin)', security: [{ BearerAuth: [] }], // Likely admin restricted
  request: { body: { content: { 'application/json': { schema: ConfigureNotionOAuthBodySchema } }, required: true } },
  responses: {
    200: { description: 'OAuth configured.', content: { 'application/json': { schema: GenericSuccessResponseSchema } } },
    400: { description: 'Bad Request.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Forbidden.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Notion', 'OAuth'],
});

// GET /notion/oauth/url - Get Notion OAuth Authorization URL
const getNotionOAuthUrlRoute = createRoute({
  method: 'get', path: '/oauth/url', summary: 'Get Notion OAuth Authorization URL', security: [{ BearerAuth: [] }],
  responses: {
    200: { description: 'OAuth URL.', content: { 'application/json': { schema: NotionOAuthUrlResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Notion', 'OAuth'],
});

// POST /notion/oauth/store - Store Notion Integration (OAuth Callback)
const storeNotionIntegrationRoute = createRoute({
  method: 'post', path: '/oauth/store', summary: 'Store Notion OAuth Integration (Callback)', security: [{ BearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: StoreNotionIntegrationBodySchema } }, required: true } },
  responses: {
    200: { description: 'Integration stored.', content: { 'application/json': { schema: GenericSuccessResponseSchema } } }, // Or NotionWorkspaceResponseSchema
    400: { description: 'Bad Request.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Notion', 'OAuth'],
});


export class NotionController {
  private getNotionServiceClient(env: AppEnv['Bindings']) {
    // Assuming NotionService is similar to TsunamiService in how it's retrieved
    return createServiceFactory().getNotionService(env);
  }

  // Placeholder methods - to be implemented
  registerNotionWorkspace = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof RegisterNotionWorkspaceBodySchema>
  ): Promise<RouteConfigToTypedResponse<typeof registerNotionWorkspaceRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, body }, 'Register Notion workspace request');
    try {
      const notionService = this.getNotionServiceClient(c.env);
      // const result = await notionService.registerWorkspace(userId, body);
      // const validatedResult = NotionWorkspaceResponseSchema.parse(result);
      // return c.json(validatedResult, 201);
      logger.warn('registerNotionWorkspace method not fully implemented');
      // Matching one of the error responses (e.g., 500)
      return c.json({ success: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 500);
    } catch (error: any) {
      logError(error, 'Register Notion workspace failed', { userId });
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed' } }, 500);
    }
  };

  getNotionWorkspaceHistory = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof WorkspaceIdParamSchema>
  ): Promise<RouteConfigToTypedResponse<typeof getNotionWorkspaceHistoryRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, params }, 'Get Notion workspace history request');
    try {
      // const notionService = this.getNotionServiceClient(c.env);
      // const history = await notionService.getWorkspaceHistory(userId, params.workspaceId);
      // const validatedHistory = NotionSyncHistoryResponseSchema.parse(history);
      // return c.json(validatedHistory, 200);
      logger.warn('getNotionWorkspaceHistory method not fully implemented');
      // Matching one of the error responses (e.g., 404)
      return c.json({ success: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 404);
    } catch (error: any) {
      logError(error, 'Get Notion workspace history failed', { userId, params });
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed' } }, 500);
    }
  };

  triggerNotionWorkspaceSync = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof WorkspaceIdParamSchema>
  ): Promise<RouteConfigToTypedResponse<typeof triggerNotionWorkspaceSyncRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, params }, 'Trigger Notion workspace sync request');
    try {
      // const notionService = this.getNotionServiceClient(c.env);
      // await notionService.triggerSync(userId, params.workspaceId);
      // return c.json({ success: true, message: 'Sync triggered' }, 202);
      logger.warn('triggerNotionWorkspaceSync method not fully implemented');
      // Matching one of the error responses (e.g., 404)
      return c.json({ success: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 404);
    } catch (error: any) {
      logError(error, 'Trigger Notion workspace sync failed', { userId, params });
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed' } }, 500);
    }
  };

  configureNotionOAuth = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof ConfigureNotionOAuthBodySchema>
  ): Promise<RouteConfigToTypedResponse<typeof configureNotionOAuthRoute>> => {
    const userId = c.get('auth')?.userId; // Check if admin
    logger.info({ userId, body }, 'Configure Notion OAuth request');
    // Add admin check here if necessary
    try {
      // const notionService = this.getNotionServiceClient(c.env);
      // await notionService.configureOAuth(body);
      // return c.json({ success: true, message: 'OAuth configured' }, 200);
      logger.warn('configureNotionOAuth method not fully implemented');
      // Matching one of the error responses (e.g., 400)
      return c.json({ success: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 400);
    } catch (error: any) {
      logError(error, 'Configure Notion OAuth failed', { userId });
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed' } }, 500);
    }
  };

  getNotionOAuthUrl = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>
  ): Promise<RouteConfigToTypedResponse<typeof getNotionOAuthUrlRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId }, 'Get Notion OAuth URL request');
    try {
      // const notionService = this.getNotionServiceClient(c.env);
      // const url = await notionService.getOAuthUrl(userId); // Or without userId if it's generic
      // return c.json({ url }, 200);
      logger.warn('getNotionOAuthUrl method not fully implemented');
      // Matching one of the error responses (e.g., 500)
      return c.json({ success: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 500);
    } catch (error: any) {
      logError(error, 'Get Notion OAuth URL failed', { userId });
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed' } }, 500);
    }
  };

  storeNotionIntegration = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof StoreNotionIntegrationBodySchema>
  ): Promise<RouteConfigToTypedResponse<typeof storeNotionIntegrationRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, body }, 'Store Notion integration request');
    try {
      // const notionService = this.getNotionServiceClient(c.env);
      // const result = await notionService.storeIntegration(userId, body.code, body.state);
      // return c.json({ success: true, message: 'Integration stored' }, 200); // Or return workspace details
      logger.warn('storeNotionIntegration method not fully implemented');
      // Matching one of the error responses (e.g., 400)
      return c.json({ success: false as const, error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented yet' } }, 400);
    } catch (error: any) {
      logError(error, 'Store Notion integration failed', { userId });
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed' } }, 500);
    }
  };
}

export function createNotionController(): NotionController {
  return new NotionController();
}

// This router will handle Notion-specific parts of the /content path
export function buildNotionContentRouter(): OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }> {
  const notionController = createNotionController();
  const router = new OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }>();

  // All routes here are relative to /content/notion (or just /content if we make paths absolute in createRoute)
  // For now, paths in createRoute are relative to where this router is mounted.
  // If mounted at /content, then path: '/' in createRoute becomes /content
  // If mounted at /content/notion, then path: '/' in createRoute becomes /content/notion

  // Assuming authenticationMiddleware is applied on the main app or a parent content router.
  // If not, it should be applied here: router.use('*', authenticationMiddleware);
  // The `security: [{ BearerAuth: [] }]` in createRoute handles OpenAPI docs and can be used by middleware.

  router.openapi(registerNotionWorkspaceRoute, (c) => notionController.registerNotionWorkspace(c, c.req.valid('json')));
  router.openapi(getNotionWorkspaceHistoryRoute, (c) => notionController.getNotionWorkspaceHistory(c, c.req.valid('param')));
  router.openapi(triggerNotionWorkspaceSyncRoute, (c) => notionController.triggerNotionWorkspaceSync(c, c.req.valid('param')));
  router.openapi(configureNotionOAuthRoute, (c) => notionController.configureNotionOAuth(c, c.req.valid('json')));
  router.openapi(getNotionOAuthUrlRoute, (c) => notionController.getNotionOAuthUrl(c));
  router.openapi(storeNotionIntegrationRoute, (c) => notionController.storeNotionIntegration(c, c.req.valid('json')));
  
  return router;
}

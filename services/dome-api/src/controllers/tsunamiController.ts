import { Context } from 'hono';
import { z, createRoute, OpenAPIHono, RouteConfigToTypedResponse } from '@hono/zod-openapi';
import { getLogger } from '@dome/common';
import { createServiceFactory } from '../services/serviceFactory';
import type { AppEnv } from '../types';
import { authenticationMiddleware, AuthContext } from '../middleware/authenticationMiddleware';

// Placeholder for actual types that might come from @dome/common or service responses
// For example:
// import { GithubRepository, SyncHistoryItem } from '@dome/common';

const logger = getLogger().child({ component: 'TsunamiController' });

// --- Generic Error Schema ---
const ErrorDetailSchema = z.object({
  code: z.string().openapi({ example: 'NOT_FOUND' }),
  message: z.string().openapi({ example: 'Resource not found' }),
});
const ErrorResponseSchema = z.object({
  success: z.literal(false).openapi({ example: false }),
  error: ErrorDetailSchema,
}).openapi('ErrorResponse');

// --- Parameter Schemas ---
const GithubRepoPathParamsSchema = z.object({
  owner: z.string().openapi({ param: { name: 'owner', in: 'path' }, example: 'my-org' }),
  repo: z.string().openapi({ param: { name: 'repo', in: 'path' }, example: 'my-repo' }),
});

const UserIdPathParamSchema = z.object({ // Renamed to avoid conflict if used elsewhere
  userId: z.string().openapi({ param: { name: 'userId', in: 'path' }, example: 'user_123' }),
});

const SyncPlanIdParamSchema = z.object({
  syncPlanId: z.string().openapi({ param: { name: 'syncPlanId', in: 'path' }, example: 'plan_abc' }),
});

// --- Body Schemas ---
const RegisterGithubRepoBodySchema = z.object({
  owner: z.string().openapi({ example: 'my-org' }),
  repo: z.string().openapi({ example: 'my-repo' }),
  // installationId: z.string().optional().openapi({ example: "gh_install_id_123"}), // If needed
}).openapi('RegisterGithubRepoBody');

const StoreGithubIntegrationBodySchema = z.object({
  installationId: z.string().openapi({ example: '1234567' }),
  // code: z.string().optional(), // For OAuth callback state
  // state: z.string().optional(), // For OAuth callback state
}).openapi('StoreGithubIntegrationBody');

// --- Response Schemas (Placeholders) ---
const GithubRepoResponseSchema = z.object({
  id: z.string().openapi({ example: 'gh_repo_123' }),
  owner: z.string().openapi({ example: 'my-org' }),
  name: z.string().openapi({ example: 'my-repo' }),
  // Add other relevant fields like defaultBranch, private, etc.
}).openapi('GithubRepoResponse');

const SyncHistoryItemSchema = z.object({
  id: z.string().openapi({ example: 'sync_hist_abc' }),
  timestamp: z.string().datetime().openapi({ example: new Date().toISOString() }),
  status: z.string().openapi({ example: 'SUCCESS' }),
  eventCount: z.number().int().optional().openapi({ example: 150 }),
  summary: z.string().optional().nullable().openapi({ example: 'Synced 150 items.' }),
}).openapi('SyncHistoryItem');
const SyncHistoryResponseSchema = z.array(SyncHistoryItemSchema).openapi('SyncHistoryResponse');

const GenericSuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
}).openapi('GenericSuccessResponse');


// --- Route Definitions ---
const registerGithubRepoRoute = createRoute({
  method: 'post', path: '/github', summary: 'Register GitHub Repository', security: [{ BearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: RegisterGithubRepoBodySchema } }, required: true } },
  responses: {
    201: { description: 'Repository registered.', content: { 'application/json': { schema: GithubRepoResponseSchema } } },
    400: { description: 'Bad Request.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - GitHub'],
});

const getGithubRepoHistoryRoute = createRoute({
  method: 'get', path: '/github/{owner}/{repo}/history', summary: 'Get GitHub Repository Sync History', security: [{ BearerAuth: [] }],
  request: { params: GithubRepoPathParamsSchema },
  responses: {
    200: { description: 'Sync history.', content: { 'application/json': { schema: SyncHistoryResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Not Found.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - GitHub'],
});

const getUserSyncHistoryRoute = createRoute({
  method: 'get', path: '/sync/user/{userId}/history', summary: 'Get User Sync History', security: [{ BearerAuth: [] }],
  request: { params: UserIdPathParamSchema },
  responses: {
    200: { description: 'User sync history.', content: { 'application/json': { schema: SyncHistoryResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Forbidden (if trying to access another user\'s history without admin rights).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Not Found.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Sync'],
});

const getSyncPlanHistoryRoute = createRoute({
  method: 'get', path: '/sync/plan/{syncPlanId}/history', summary: 'Get Sync Plan History', security: [{ BearerAuth: [] }],
  request: { params: SyncPlanIdParamSchema },
  responses: {
    200: { description: 'Sync plan history.', content: { 'application/json': { schema: SyncHistoryResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Not Found.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - Sync'],
});

const storeGithubIntegrationRoute = createRoute({
  method: 'post', path: '/github/oauth/store', summary: 'Store GitHub OAuth Integration', security: [{ BearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: StoreGithubIntegrationBodySchema } }, required: true } },
  responses: {
    200: { description: 'Integration stored.', content: { 'application/json': { schema: GenericSuccessResponseSchema } } },
    400: { description: 'Bad Request.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Internal Server Error.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  }, tags: ['Content - GitHub', 'OAuth'],
});

export class TsunamiController {
  private getTsunamiServiceClient(env: AppEnv['Bindings']) {
    return createServiceFactory().getTsunamiService(env);
  }

  registerGithubRepo = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof RegisterGithubRepoBodySchema>
  ): Promise<RouteConfigToTypedResponse<typeof registerGithubRepoRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, owner: body.owner, repo: body.repo }, 'Register GitHub repo request');
    try {
      const tsunamiService = this.getTsunamiServiceClient(c.env);
      // Corrected: Pass owner and repo as separate arguments, assuming this matches the service client
      const result = await tsunamiService.registerGithubRepo(body.owner, body.repo, userId);
      const validatedResult = GithubRepoResponseSchema.parse(result); // Validate/transform service response
      return c.json(validatedResult, 201);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId }, 'Register GitHub repo failed');
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed to register repo' } }, 500);
    }
  };

  getGithubRepoHistory = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof GithubRepoPathParamsSchema>
  ): Promise<RouteConfigToTypedResponse<typeof getGithubRepoHistoryRoute>> => {
    const userId = c.get('auth')?.userId; // For auth check if service requires it
    logger.info({ userId, params }, 'Get GitHub repo history request');
    try {
      const tsunamiService = this.getTsunamiServiceClient(c.env);
      // ASSUMPTION: tsunamiService.getGithubRepoHistory(owner, repo, userId_for_auth_check_if_needed)
      const history = await tsunamiService.getGithubRepoHistory(params.owner, params.repo);
      const validatedHistory = SyncHistoryResponseSchema.parse(history);
      return c.json(validatedHistory, 200);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId, params }, 'Get GitHub repo history failed');
      if (error.code === 'NOT_FOUND' || error.message?.includes('not found')) {
        return c.json({ success: false as const, error: { code: 'NOT_FOUND', message: 'Repository or history not found' } }, 404);
      }
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed to get repo history' } }, 500);
    }
  };

  getUserHistory = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof UserIdPathParamSchema>
  ): Promise<RouteConfigToTypedResponse<typeof getUserSyncHistoryRoute>> => {
    const authenticatedUserId = c.get('auth')?.userId;
    // Basic authorization: user can only get their own history unless they are an admin (not implemented here)
    if (params.userId !== authenticatedUserId) {
        logger.warn({ requestedUserId: params.userId, authenticatedUserId }, "Forbidden attempt to access another user's sync history");
        return c.json({ success: false as const, error: { code: 'FORBIDDEN', message: 'Cannot access another user\'s sync history.'}}, 403);
    }
    logger.info({ userId: params.userId }, 'Get user sync history request');
    try {
      const tsunamiService = this.getTsunamiServiceClient(c.env);
      // ASSUMPTION: tsunamiService.getUserHistory(targetUserId)
      const history = await tsunamiService.getUserHistory(params.userId);
      const validatedHistory = SyncHistoryResponseSchema.parse(history);
      return c.json(validatedHistory, 200);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId: params.userId }, 'Get user sync history failed');
      if (error.code === 'NOT_FOUND' || error.message?.includes('not found')) {
        return c.json({ success: false as const, error: { code: 'NOT_FOUND', message: 'User or history not found' } }, 404);
      }
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed to get user sync history' } }, 500);
    }
  };

  getSyncPlanHistory = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    params: z.infer<typeof SyncPlanIdParamSchema>
  ): Promise<RouteConfigToTypedResponse<typeof getSyncPlanHistoryRoute>> => {
    const userId = c.get('auth')?.userId; // For auth check if service requires it
    logger.info({ userId, params }, 'Get sync plan history request');
    try {
      const tsunamiService = this.getTsunamiServiceClient(c.env);
      // ASSUMPTION: tsunamiService.getSyncPlanHistory(syncPlanId, userId_for_auth_check)
      const history = await tsunamiService.getSyncPlanHistory(params.syncPlanId);
      const validatedHistory = SyncHistoryResponseSchema.parse(history);
      return c.json(validatedHistory, 200);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId, params }, 'Get sync plan history failed');
      if (error.code === 'NOT_FOUND' || error.message?.includes('not found')) {
        return c.json({ success: false as const, error: { code: 'NOT_FOUND', message: 'Sync plan or history not found' } }, 404);
      }
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed to get sync plan history' } }, 500);
    }
  };

  /*
  storeGithubIntegration = async (
    c: Context<AppEnv & { Variables: { auth: AuthContext } }>,
    body: z.infer<typeof StoreGithubIntegrationBodySchema>
  ): Promise<RouteConfigToTypedResponse<typeof storeGithubIntegrationRoute>> => {
    const userId = c.get('auth')?.userId;
    logger.info({ userId, installationId: body.installationId }, 'Store GitHub integration request');
    try {
      const tsunamiService = this.getTsunamiServiceClient(c.env);
      // TODO: Identify and call the correct tsunamiService method here
      // For example: await tsunamiService.actualStoreGithubIntegrationMethod(body, userId);
      logger.warn("storeGithubIntegration's underlying service method is not implemented/identified yet.");
      return c.json({ success: true, message: 'GitHub integration storage (placeholder - needs implementation).' }, 200);
    } catch (error: any) {
      logger.error({ error: error.message, stack: error.stack, userId }, 'Store GitHub integration failed');
      return c.json({ success: false as const, error: { code: 'INTERNAL_SERVER_ERROR', message: String(error.message) || 'Failed to store GitHub integration' } }, 500);
    }
  };
  */
}

export function createTsunamiController(): TsunamiController {
  return new TsunamiController();
}

// This router will handle Tsunami-specific parts of the /content path
export function buildTsunamiContentRouter(): OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }> {
  const tsunamiController = createTsunamiController();
  const router = new OpenAPIHono<AppEnv & { Variables: { auth: AuthContext } }>();

  // All routes here are already under /content, so paths are relative to that
  // Middleware is applied here if not already on the main content router in index.ts
  // For now, assuming authenticationMiddleware is applied on the main content router in index.ts
  // If not, add: router.use('*', authenticationMiddleware);

  router.openapi(registerGithubRepoRoute, (c) => tsunamiController.registerGithubRepo(c, c.req.valid('json')));
  router.openapi(getGithubRepoHistoryRoute, (c) => tsunamiController.getGithubRepoHistory(c, c.req.valid('param')));
  router.openapi(getUserSyncHistoryRoute, (c) => tsunamiController.getUserHistory(c, c.req.valid('param')));
  router.openapi(getSyncPlanHistoryRoute, (c) => tsunamiController.getSyncPlanHistory(c, c.req.valid('param')));
  // router.openapi(storeGithubIntegrationRoute, (c) => tsunamiController.storeGithubIntegration(c, c.req.valid('json'))); // storeGithubIntegration method is commented out
  
  return router;
}

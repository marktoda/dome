/**
 * Tsunami Service – simplified
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { ServiceInfo, createErrorMiddleware, formatZodError } from '@dome/common';
import { z } from 'zod';
import { getLogger, logError, metrics } from '@dome/logging';
import { createSiloService } from './services/siloService';
import { createSyncPlanService } from './services/syncPlanService';
import { syncHistoryOperations } from './db/client';
import { Bindings } from './types';
import { ProviderType } from './providers';

/* ─────────── shared utils ─────────── */

const logger = getLogger(); // one logger, reused everywhere

const handle = (
  c: { json: (data: any, status?: number) => Response },
  fn: () => Promise<Response>,
): Promise<Response> =>
  fn().catch(err => {
    logError(logger, err, 'Unhandled request error');
    return c.json({ success: false, error: err.message ?? 'Internal error' }, 500);
  });

const buildServices = (env: Bindings) => ({
  silo: createSiloService(env),
  syncPlan: createSyncPlanService(env),
});

/* ─────────── app bootstrap ─────────── */

const serviceInfo: ServiceInfo = { name: 'tsunami', version: '0.1.0', environment: 'development' };
logger.info(serviceInfo, 'Starting Tsunami service');

const app = new Hono<{ Bindings: Bindings }>();
app.use(cors());
app.use('*', createErrorMiddleware(formatZodError));
app.get('/', c => c.text('Hello from Tsunami!'));

/* ─────────── schemas ─────────── */

const githubRepoSchema = z.object({
  userId: z.string().optional(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  cadence: z.string().default('PT1H'),
});

const syncHistoryQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(10),
});

/* ─────────── helpers ─────────── */

type HistoryFetcher = (env: D1Database, id: string, limit: number) => Promise<unknown[]>;

/** Creates a GET route with identical body/limit/error handling logic */
function historyRoute(path: string, idParamKey: string, fetcher: HistoryFetcher) {
  app.get(path, zValidator('query', syncHistoryQuerySchema), async c =>
    handle(c, async () => {
      const params = c.req.param();
      // Use type assertion to avoid TypeScript error
      const id = params[idParamKey as keyof typeof params] as string;
      const { limit } = c.req.valid('query');

      const history = await fetcher(c.env.SYNC_PLAN, id, limit);
      logger.info({ id, path, count: history.length }, 'History fetched');

      return c.json({ success: true, [idParamKey]: id, history });
    }),
  );
}

/* ─────────── routes ─────────── */

// Register GitHub repo
app.post('/resource/github', zValidator('json', githubRepoSchema), async c =>
  handle(c, async () => {
    const { owner, repo, userId } = c.req.valid('json');

    // Validate owner and repo
    if (!owner || !repo) {
      return c.json(
        {
          success: false,
          error: 'Invalid owner or repo. Both must be non-empty strings.',
        },
        400,
      );
    }

    const resourceId = `${owner}/${repo}`;
    const { syncPlan } = buildServices(c.env);

    logger.info({ owner, repo, resourceId, userId }, 'Registering GitHub repository');

    try {
      const { id, isNew } = await syncPlan.findOrCreateSyncPlan('github', resourceId, userId);

      const wasInitialized = await syncPlan.initializeOrSyncResource(
        resourceId,
        ProviderType.GITHUB,
        userId,
        3600,
      );

      logger.info(
        { id, resourceId, isNew, wasInitialized },
        'GitHub repository registered successfully',
      );

      return c.json({
        success: true,
        id,
        resourceId,
        isNew,
        wasInitialized,
      });
    } catch (error) {
      logger.error(
        {
          owner,
          repo,
          resourceId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to register GitHub repository',
      );

      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to register GitHub repository',
        },
        500,
      );
    }
  }),
);

// Modified implementation for GitHub repository history
app.get(
  '/resource/github/:owner/:repo/history',
  zValidator('query', syncHistoryQuerySchema),
  async c =>
    handle(c, async () => {
      const params = c.req.param();
      const owner = params.owner as string;
      const repo = params.repo as string;
      const { limit } = c.req.valid('query');

      if (!owner || !repo) {
        logger.error({ params }, 'Missing owner or repo parameter');
        return c.json(
          {
            success: false,
            error: 'Invalid URL format. Expected /resource/github/:owner/:repo/history',
          },
          400,
        );
      }

      const resourceId = `${owner}/${repo}`;
      logger.info({ owner, repo, resourceId }, 'Fetching history for GitHub repository');

      const history = await syncHistoryOperations.getByResourceId(
        c.env.SYNC_PLAN,
        resourceId,
        limit,
      );

      logger.info({ resourceId, count: history.length }, 'History fetched');

      return c.json({
        success: true,
        owner,
        repo,
        resourceId,
        history,
      });
    }),
);

historyRoute('/user/:userId/history', 'userId', syncHistoryOperations.getByUserId);

historyRoute('/sync-plan/:syncPlanId/history', 'syncPlanId', syncHistoryOperations.getBySyncPlanId);

export default app;

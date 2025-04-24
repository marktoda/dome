/**
 * Tsunami Service – simplified (uses new SyncPlanService API)
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ServiceInfo, createErrorMiddleware, formatZodError, createDetailedLoggerMiddleware } from '@dome/common';
import { getLogger, logError } from '@dome/logging';
import {
  createSyncPlanService,
  AlreadyExistsError,
  NotFoundError,
} from './services/syncPlanService';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { syncHistoryOperations } from './db/client';
import { ProviderType } from './providers';
import { Bindings } from './types';

export { ResourceObject } from './resourceObject';

/* ─────────── shared utils ─────────── */

const logger = getLogger();

const handle = (
  c: { json: (d: unknown, status?: number) => Response },
  fn: () => Promise<Response>,
) =>
  fn().catch(err => {
    logError(logger, err, 'Unhandled request error');
    return c.json({ success: false, error: err.message ?? 'Internal error' }, 500);
  });

const buildServices = (env: Bindings) => ({
  silo: new SiloClient(env.SILO as unknown as SiloBinding, env.SILO_INGEST_QUEUE),
  syncPlan: createSyncPlanService(env),
});

/* ─────────── app bootstrap ─────────── */

const serviceInfo: ServiceInfo = { name: 'tsunami', version: '0.1.0', environment: 'development' };
logger.info(serviceInfo, 'Starting Tsunami service');

const app = new Hono<{ Bindings: Bindings }>();
app.use(cors());
app.use('*', createDetailedLoggerMiddleware());
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

function historyRoute(path: string, idParamKey: string, fetcher: HistoryFetcher) {
  app.get(path, zValidator('query', syncHistoryQuerySchema), async c =>
    handle(c, async () => {
      const params = c.req.param();
      const id = params[idParamKey as keyof typeof params] as string;
      const { limit } = c.req.valid('query');

      const history = await fetcher(c.env.SYNC_PLAN, id, limit);
      logger.info({ id, path, count: history.length }, 'History fetched');

      return c.json({ success: true, [idParamKey]: id, history });
    }),
  );
}

/* ─────────── routes ─────────── */

// Register / initialise / sync a GitHub repository
app.post('/resource/github', zValidator('json', githubRepoSchema), async c =>
  handle(c, async () => {
    const { owner, repo, userId } = c.req.valid('json');
    const resourceId = `${owner}/${repo}`;
    const { syncPlan } = buildServices(c.env);

    logger.info({ owner, repo, resourceId, userId }, 'Registering GitHub repository');

    // create sync plan (or skip if it exists)
    let syncPlanId: string;
    try {
      // Try to create a brand‑new sync‑plan
      syncPlanId = await syncPlan.createSyncPlan('github', resourceId, userId);
      logger.info({ syncPlanId, resourceId }, 'Sync‑plan created');
    } catch (err) {
      if (err instanceof AlreadyExistsError) {
        // Plan exists – fetch its id
        const plan = await syncPlan.getSyncPlan(resourceId);
        syncPlanId = plan.id;
        logger.info({ syncPlanId, resourceId }, 'Sync‑plan already exists');
      } else {
        throw err;
      }
    }

    // Always attach the user if supplied (idempotent if already attached)
    if (userId) {
      await syncPlan.attachUser(syncPlanId, userId);
      logger.info({ syncPlanId, userId }, 'User attached to sync‑plan');
    }

    const created = await syncPlan.initializeResource(
      { resourceId, providerType: ProviderType.GITHUB, userId },
      /* cadenceSecs = */ 3_600,
    );

    logger.info(
      { syncPlanId, resourceId, created },
      'GitHub repository initialised & synced successfully',
    );

    return c.json({
      success: true,
      id: syncPlanId,
      resourceId,
      wasInitialised: created,
    });
  }),
);

// History endpoints
app.get(
  '/resource/github/:owner/:repo/history',
  zValidator('query', syncHistoryQuerySchema),
  async c =>
    handle(c, async () => {
      const { owner, repo } = c.req.param();
      const { limit } = c.req.valid('query');

      const resourceId = `${owner}/${repo}`;
      const history = await syncHistoryOperations.getByResourceId(
        c.env.SYNC_PLAN,
        resourceId,
        limit,
      );

      return c.json({ success: true, owner, repo, resourceId, history });
    }),
);

historyRoute('/user/:userId/history', 'userId', syncHistoryOperations.getByUserId);
historyRoute('/sync-plan/:syncPlanId/history', 'syncPlanId', syncHistoryOperations.getBySyncPlanId);

export default app;

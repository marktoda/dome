/**
 * Tsunami Service – simplified (uses new SyncPlanService API)
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ServiceInfo,
  createDetailedLoggerMiddleware,
  formatZodError,
} from '@dome/common';
import {
  getLogger,
  logError,
  trackOperation,
  createServiceMetrics
} from '@dome/logging';
import {
  toDomeError,
  NotFoundError,
  ConflictError,
  ValidationError,
  createErrorMiddleware,
} from './utils/errors';
import {
  createSyncPlanService,
} from './services/syncPlanService';
import { SiloClient, SiloBinding } from '@dome/silo/client';
import { syncHistoryOperations } from './db/client';
import { ProviderType } from './providers';
import { Bindings } from './types';

export { ResourceObject } from './resourceObject';

/* ─────────── shared utils ─────────── */

const logger = getLogger();
const metrics = createServiceMetrics('tsunami');

const handle = (
  c: {
    json: (d: unknown, status?: number) => Response;
    req: {
      path: string;
      method: string;
      header: (name: string) => string | undefined;
    }
  },
  fn: () => Promise<Response>,
) =>
  fn().catch(err => {
    const path = c.req?.path || 'unknown';
    const method = c.req?.method || 'unknown';
    const requestId = c.req?.header('x-request-id') || 'unknown';
    
    const domeError = toDomeError(err, 'Unhandled request error', {
      path,
      method,
      requestId
    });
    logError(domeError, 'Unhandled request error');
    metrics.trackOperation('request', false, { path, error_code: domeError.code });
    return c.json({
      success: false,
      error: {
        code: domeError.code,
        message: domeError.message,
        details: domeError.details
      }
    }, domeError.statusCode);
  });

const buildServices = (env: Bindings) => ({
  silo: new SiloClient(env.SILO as unknown as SiloBinding, env.SILO_INGEST_QUEUE),
  syncPlan: createSyncPlanService(env),
});

/* ─────────── app bootstrap ─────────── */

const serviceInfo: ServiceInfo = {
  name: 'tsunami',
  version: '0.1.0',
  environment: process.env.ENVIRONMENT || 'development'
};
logger.info({
  event: 'service_start',
  ...serviceInfo
}, 'Starting Tsunami service');

const app = new Hono<{ Bindings: Bindings }>();
app.use(cors());
app.use('*', createDetailedLoggerMiddleware());
app.use('*', createErrorMiddleware({
  errorMapper: (err) => {
    if (err instanceof Error && err.name === 'ZodError') {
      // Format Zod validation errors
      return new ValidationError('Validation error', formatZodError(err as any));
    }
    return toDomeError(err);
  }
}));
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
      logger.info({
        event: 'history_fetched',
        id,
        path,
        count: history.length,
        requestId: c.req.header('x-request-id')
      }, 'History fetched successfully');

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
    const requestId = c.req.header('x-request-id') || 'unknown';

    logger.info({
      event: 'github_repo_registration_start',
      owner,
      repo,
      resourceId,
      userId,
      requestId
    }, 'Starting GitHub repository registration');

    // create sync plan (or skip if it exists)
    let syncPlanId: string;
    try {
      // Try to create a brand‑new sync‑plan
      syncPlanId = await trackOperation(
        'create_sync_plan',
        () => syncPlan.createSyncPlan('github', resourceId, userId),
        { resourceId, userId, requestId }
      );
      logger.info({
        event: 'sync_plan_created',
        syncPlanId,
        resourceId,
        requestId
      }, 'Sync‑plan created successfully');
    } catch (err) {
      if (err instanceof ConflictError) {
        // Plan exists – fetch its id
        const plan = await trackOperation(
          'get_sync_plan',
          () => syncPlan.getSyncPlan(resourceId),
          { resourceId, requestId }
        );
        syncPlanId = plan.id;
        logger.info({
          event: 'sync_plan_exists',
          syncPlanId,
          resourceId,
          requestId
        }, 'Sync‑plan already exists');
      } else {
        throw toDomeError(err, 'Failed to create or retrieve sync plan', {
          resourceId,
          userId,
          requestId
        });
      }
    }

    // Always attach the user if supplied (idempotent if already attached)
    if (userId) {
      await trackOperation(
        'attach_user_to_plan',
        () => syncPlan.attachUser(syncPlanId, userId),
        { syncPlanId, userId, requestId }
      );
      logger.info({
        event: 'user_attached',
        syncPlanId,
        userId,
        requestId
      }, 'User attached to sync‑plan successfully');
    }

    const created = await trackOperation(
      'initialize_resource',
      () => syncPlan.initializeResource(
        { resourceId, providerType: ProviderType.GITHUB, userId },
        /* cadenceSecs = */ 3_600,
      ),
      { syncPlanId, resourceId, userId, requestId }
    );

    logger.info(
      {
        event: 'github_repo_initialized',
        syncPlanId,
        resourceId,
        created,
        requestId
      },
      'GitHub repository initialised & synced successfully',
    );
    
    metrics.trackOperation('github_repo_registration', true, { created: String(created) });

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

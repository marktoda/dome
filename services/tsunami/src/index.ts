/**
 * Tsunami Service
 *
 * This service is responsible for ingesting content from external sources
 * (like GitHub repositories) and storing it in the Silo service for further
 * processing, embedding, and retrieval.
 *
 * @module tsunami
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { ServiceInfo, createErrorMiddleware, formatZodError } from '@dome/common';
import { z } from 'zod';
import { ulid } from 'ulid';
import { getLogger, logError, metrics } from '@dome/logging';
import { createSiloService } from './services/siloService';
import { createSyncPlanService } from './services/syncPlanService';
import { syncPlanOperations } from './db/client';
import { Bindings } from './types';
import { ProviderType } from './providers';

export { ResourceObject } from './resourceObject';

/**
 * Build service clients for the Tsunami worker
 *
 * @param env - The environment bindings
 * @returns An object containing service clients
 */
const buildServices = (env: Bindings) => ({
  silo: createSiloService(env),
  syncPlan: createSyncPlanService(env),
});

const serviceInfo: ServiceInfo = {
  name: 'tsunami',
  version: '0.1.0',
  environment: 'development',
};

const app = new Hono<{ Bindings: Bindings }>();
app.use(cors());
app.use('*', createErrorMiddleware(formatZodError));

// Initialize logging with service info
const logger = getLogger();
logger.info({ ...serviceInfo }, 'Initializing Tsunami service');

// Add error handling middleware
app.onError((err, c) => {
  logger.error({ error: err }, 'Request error');
  return c.json(
    {
      success: false,
      error: err.message || 'Unknown error',
    },
    500,
  );
});

app.get('/', c => c.text('Hello from Tsunami!'));

/**
 * Schema for GitHub repository registration
 *
 * Validates the input for registering a GitHub repository for syncing.
 * Requires owner and repo, with optional userId and cadence.
 */
const githubRepoSchema = z.object({
  /** User ID who owns this sync plan */
  userId: z.string().optional(),
  /** Repository owner (organization or user) */
  owner: z.string().min(1, 'Repository owner is required'),
  /** Repository name */
  repo: z.string().min(1, 'Repository name is required'),
  /** Sync frequency in ISO 8601 duration format, default 1 hour */
  cadence: z.string().default('PT1H'),
});

/**
 * Register a GitHub repository for syncing
 *
 * This endpoint creates a new sync plan for a GitHub repository and initializes
 * a ResourceObject to manage the sync state.
 *
 * @route POST /resource/github
 * @param {Object} body - The request body containing repository details
 * @returns {Object} Response with success status and repository details
 */
app.post('/resource/github', zValidator('json', githubRepoSchema), async c => {
  const logger = getLogger();
  const data = c.req.valid('json');
  const { userId, owner, repo, cadence } = data;
  const resourceId = `${owner}/${repo}`;
  const services = buildServices(c.env);

  try {
    // Use the SyncPlanService to find or create a sync plan
    const { id, isNew } = await services.syncPlan.findOrCreateSyncPlan(
      'github',
      resourceId,
      userId,
    );

    // Parse cadence string to seconds (default to 1 hour)
    // For simplicity, we're just using a fixed value here
    const cadenceSecs = 3600;

    // Initialize or sync the resource
    const wasInitialized = await services.syncPlan.initializeOrSyncResource(
      resourceId,
      ProviderType.GITHUB,
      userId,
      cadenceSecs,
    );

    // Return appropriate response based on whether it was new or existing
    const message = isNew
      ? `GitHub repository ${resourceId} registered for syncing`
      : `GitHub repository ${resourceId} already registered, added user to existing sync plan`;

    logger.info({ id, resourceId, isNew, wasInitialized }, 'GitHub repository sync plan status');
    return c.json({
      success: true,
      id,
      resourceId,
      message,
    });
  } catch (error) {
    logError(logger, error, 'Error registering GitHub repository', { resourceId });
    metrics.increment('tsunami.register.errors', 1);

    throw error;
  }
});

/* -------------------------------------------------------------------------- */
/* worker                                                                     */
/* -------------------------------------------------------------------------- */

// /**
//  * Tsunami Worker
//  *
//  * Main worker class for the Tsunami service. Handles scheduled triggers for
//  * syncing external content sources and provides API endpoints for managing
//  * sync plans.
//  *
//  * @class
//  */
// export default class Tsunami extends WorkerEntrypoint<Env> {
//   /** Lazily created bundle of service clients (re‑used for every call) */
//   private _services?: ReturnType<typeof buildServices>;
//   private get services() {
//     return (this._services ??= buildServices(this.env));
//   }
//
//   fetch = app.fetch;
// }
//
export default app;

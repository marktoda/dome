/**
 * GitHub Ingestor Service entrypoint
 *
 * This is the main entry point for the GitHub Ingestor service, implementing a WorkerEntrypoint
 * class that handles HTTP requests, scheduled events, and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Env, IngestMessage } from './types';
import { handleWebhook } from './webhook/http';
import { processQueueBatch } from './queue/processor';
import { handleCron } from './cron/handler';
import { initLogger, createRequestLogger, createRepoLogger } from './utils/logging';
import { getLogger } from '@dome/logging';
import { metrics } from './utils/metrics';
import { Hono } from 'hono';
import { ServiceFactory } from './services';
import { RpcService } from './rpc/service';
import { ulid } from 'ulid';
import { wrap } from './utils/wrap';

/**
 * GitHub Ingestor Worker Entry Point class for handling HTTP requests, cron events, and queue messages
 * Implements the Cloudflare Worker interface
 */
export default class GitHubIngestor extends WorkerEntrypoint<Env> {
  private app: Hono;
  private services: ServiceFactory;
  private rpcService: RpcService;

  /**
   * Create a new GitHub Ingestor worker entry point
   * @param ctx Execution context
   * @param env Environment variables and bindings
   */
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    this.services = new ServiceFactory(env);
    this.rpcService = new RpcService(this.services, env);
    this.app = this.createApp();
  }

  /**
   * Create the Hono app for handling HTTP requests
   * @returns Hono app
   */
  private createApp(): Hono {
    const app = new Hono();

    // Initialize logger and metrics with environment variables
    initLogger(this.env);
    metrics.init(this.env);

    // Root endpoint
    app.get('/', c => {
      return c.json({
        service: 'github-ingestor',
        version: this.env.VERSION,
        environment: this.env.ENVIRONMENT,
        description: 'GitHub Ingestor service for processing GitHub repositories',
        endpoints: {
          '/': 'Service information',
          '/health': 'Health check endpoint',
          '/status': 'Detailed status information',
          '/webhook': 'GitHub webhook endpoint (POST only)',
          '/rpc/*': 'RPC endpoints for internal service communication',
        },
      });
    });

    // GitHub webhook endpoint
    app.post('/webhook', async c => {
      const requestId = c.req.header('x-request-id') || ulid();
      const requestLogger = createRequestLogger(requestId);

      try {
        return await handleWebhook(c.req.raw, this.env);
      } catch (error) {
        const errorObj = error as Error;
        requestLogger.error(
          {
            error: errorObj,
            errorStack: errorObj.stack,
            errorName: errorObj.name,
          },
          'Error handling webhook',
        );

        metrics.counter('webhook.error', 1);

        return new Response(
          JSON.stringify({
            status: 'error',
            error: {
              message: errorObj.message,
              name: errorObj.name,
              stack: this.env.ENVIRONMENT === 'dev' ? errorObj.stack : undefined,
            },
            request_id: requestId,
            timestamp: new Date().toISOString(),
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        );
      }
    });

    // Health check endpoint
    app.get('/health', async c => {
      const startTime = performance.now();
      const requestId = c.req.header('x-request-id') || ulid();
      const requestLogger = createRequestLogger(requestId);

      try {
        // Check database connection
        let dbStatus = 'ok';
        let dbError = null;
        let dbDetails = null;

        try {
          // More comprehensive database check
          // First check basic connectivity
          const result = await this.env.DB.prepare('SELECT 1 as connected').first();

          if (!result || result.connected !== 1) {
            throw new Error('Database connectivity check failed');
          }

          // Then check if required tables exist
          const tableCheck = await this.env.DB.prepare(
            `
            SELECT name FROM sqlite_master
            WHERE type='table' AND (
              name='provider_repositories' OR
              name='provider_credentials' OR
              name='content_blobs'
            )
          `,
          ).all();

          const tables = tableCheck.results?.map((row: any) => row.name) || [];
          const requiredTables = ['provider_repositories', 'provider_credentials', 'content_blobs'];
          const missingTables = requiredTables.filter(table => !tables.includes(table));

          if (missingTables.length > 0) {
            dbStatus = 'warning';
            dbDetails = `Missing tables: ${missingTables.join(', ')}`;
            requestLogger.warn({ missingTables }, 'Database missing required tables');
          } else {
            dbDetails = 'All required tables present';
          }
        } catch (error) {
          dbStatus = 'error';
          dbError = (error as Error).message;
          requestLogger.error(
            {
              error,
              errorStack: (error as Error).stack,
              errorName: (error as Error).name,
            },
            'Database health check failed',
          );
        }

        // Check queue status
        const queueStatus = 'ok'; // Queue binding doesn't provide a way to check health

        // Check GitHub credentials
        let githubStatus = 'unknown';
        let githubError = null;

        // Check if required GitHub environment variables are set
        const requiredGithubVars = [
          'GITHUB_APP_ID',
          'GITHUB_PRIVATE_KEY',
          'GITHUB_WEBHOOK_SECRET',
          'GITHUB_TOKEN',
        ];

        const missingVars = requiredGithubVars.filter(
          varName =>
            !this.env[varName as keyof Env] ||
            (this.env[varName as keyof Env] as string).trim() === '',
        );

        if (missingVars.length > 0) {
          githubStatus = 'error';
          githubError = `Missing required environment variables: ${missingVars.join(', ')}`;
          requestLogger.error({ missingVars }, 'Missing required GitHub environment variables');
        } else {
          githubStatus = 'ok';
        }

        // Determine overall status (ok only if all components are ok)
        const overallStatus =
          dbStatus === 'ok' && queueStatus === 'ok' && githubStatus === 'ok'
            ? 'ok'
            : dbStatus === 'error' || githubStatus === 'error'
            ? 'error'
            : 'warning';

        // Record metrics
        const duration = Math.round(performance.now() - startTime);
        metrics.trackHealthCheck(overallStatus as any, duration);
        metrics.trackHealthCheck(dbStatus as any, duration, 'database');
        metrics.trackHealthCheck(queueStatus as any, duration, 'queue');
        metrics.trackHealthCheck(githubStatus as any, duration, 'github');

        // Return health status
        return c.json({
          status: overallStatus,
          version: this.env.VERSION,
          environment: this.env.ENVIRONMENT,
          request_id: requestId,
          components: {
            database: {
              status: dbStatus,
              error: dbError,
              details: dbDetails,
            },
            queue: {
              status: queueStatus,
            },
            github: {
              status: githubStatus,
              error: githubError,
            },
          },
          uptime: Math.floor(performance.now() / 1000),
        });
      } catch (error) {
        const errorObj = error as Error;
        requestLogger.error(
          {
            error: errorObj,
            errorStack: errorObj.stack,
            errorName: errorObj.name,
          },
          'Health check failed',
        );

        metrics.trackHealthCheck('error', Math.round(performance.now() - startTime));

        return c.json(
          {
            status: 'error',
            version: this.env.VERSION,
            environment: this.env.ENVIRONMENT,
            request_id: requestId,
            error: {
              message: errorObj.message,
              name: errorObj.name,
              stack: this.env.ENVIRONMENT === 'dev' ? errorObj.stack : undefined,
            },
            timestamp: new Date().toISOString(),
          },
          500,
        );
      }
    });

    // Detailed status endpoint
    app.get('/status', async c => {
      const startTime = performance.now();
      const requestId = c.req.header('x-request-id') || ulid();
      const requestLogger = createRequestLogger(requestId);

      try {
        // Get repository counts
        const repoStats = await this.env.DB.prepare(
          `
          SELECT
            COUNT(*) as total_repos,
            SUM(CASE WHEN lastSyncedAt IS NOT NULL THEN 1 ELSE 0 END) as synced_repos,
            SUM(CASE WHEN isPrivate = 1 THEN 1 ELSE 0 END) as private_repos
          FROM provider_repositories
          WHERE provider = 'github'
        `,
        ).first();

        // Get recent errors
        const recentErrors = await this.env.DB.prepare(
          `
          SELECT id, userId, owner, repo, retryCount, nextRetryAt
          FROM provider_repositories
          WHERE provider = 'github' AND retryCount > 0
          ORDER BY nextRetryAt DESC
          LIMIT 5
        `,
        ).all();

        // Get queue metrics from memory (since we can't query the queue directly)
        const queueMetrics = {
          processed_last_hour: metrics.getCounter('queue.messages_processed') || 0,
          errors_last_hour: metrics.getCounter('queue.messages_failed') || 0,
        };

        // Record metrics
        const duration = Math.round(performance.now() - startTime);
        metrics.timing('status.duration_ms', duration);

        // Return detailed status
        return c.json({
          status: 'ok',
          version: this.env.VERSION,
          environment: this.env.ENVIRONMENT,
          request_id: requestId,
          uptime: Math.floor(performance.now() / 1000),
          repositories: {
            total: repoStats?.total_repos || 0,
            synced: repoStats?.synced_repos || 0,
            private: repoStats?.private_repos || 0,
          },
          queue: queueMetrics,
          recent_errors: recentErrors?.results || [],
          memory_usage: {
            // Cloudflare Workers don't provide memory usage metrics
            // Use a placeholder value that won't cause runtime errors
            rss: 0,
          },
        });
      } catch (error) {
        const errorObj = error as Error;
        requestLogger.error(
          {
            error: errorObj,
            errorStack: errorObj.stack,
            errorName: errorObj.name,
          },
          'Status check failed',
        );

        metrics.counter('status.error', 1);

        return c.json(
          {
            status: 'error',
            version: this.env.VERSION,
            environment: this.env.ENVIRONMENT,
            request_id: requestId,
            error: {
              message: errorObj.message,
              name: errorObj.name,
              stack: this.env.ENVIRONMENT === 'dev' ? errorObj.stack : undefined,
            },
            timestamp: new Date().toISOString(),
          },
          500,
        );
      }
    });

    // RPC endpoints
    app.use('/rpc/*', c => this.rpcService.fetch(c.req.raw));

    // Catch-all for other routes
    app.all('*', c => {
      return c.json({ error: 'Not found' }, 404);
    });

    return app;
  }

  /**
   * Handle HTTP requests
   * @param request HTTP request
   * @returns HTTP response
   */
  async fetch(request: Request): Promise<Response> {
    return wrap(
      { operation: 'fetch', method: request.method, path: new URL(request.url).pathname },
      async () => {
        metrics.counter('http.request', 1, {
          method: request.method,
          path: new URL(request.url).pathname,
        });

        return this.app.fetch(request, this.env, this.ctx);
      },
    ).catch(error => {
      const errorObj = error as Error;
      const requestId = ulid();
      getLogger().error(
        {
          error: errorObj,
          errorStack: errorObj.stack,
          errorName: errorObj.name,
          url: request.url,
          requestId,
        },
        'Unhandled error in fetch handler',
      );

      metrics.counter('http.error', 1);

      return new Response(
        JSON.stringify({
          status: 'error',
          error: {
            message: errorObj.message,
            name: errorObj.name,
            stack: this.env.ENVIRONMENT === 'dev' ? errorObj.stack : undefined,
          },
          request_id: requestId,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );
    });
  }

  /**
   * Handle scheduled cron events
   * @param controller Scheduled controller
   */
  async scheduled(controller: ScheduledController): Promise<void> {
    await wrap({ operation: 'scheduled', cron: controller.cron }, async () => {
      getLogger().info({ cron: controller.cron }, 'Running scheduled repository sync');
      metrics.counter('cron.triggered', 1);

      // Run the cron handler
      await handleCron(this.env, this.ctx);

      getLogger().info('Scheduled repository sync completed');
    }).catch(error => {
      const errorObj = error as Error;
      getLogger().error(
        {
          error: errorObj,
          errorStack: errorObj.stack,
          errorName: errorObj.name,
          cron: controller.cron,
        },
        'Error in scheduled repository sync',
      );

      metrics.counter('cron.error', 1);
    });
  }

  /**
   * Handle queue messages
   * @param batch Message batch
   */
  async queue(batch: MessageBatch<IngestMessage>): Promise<void> {
    await wrap({ operation: 'queue', messageCount: batch.messages.length }, async () => {
      getLogger().info({ messageCount: batch.messages.length }, 'Processing queue batch');
      metrics.counter('queue.batch_received', 1, {
        message_count: batch.messages.length.toString(),
      });

      await processQueueBatch(batch, this.env);

      getLogger().info('Queue batch processing completed');
    }).catch(error => {
      const errorObj = error as Error;
      getLogger().error(
        {
          error: errorObj,
          errorStack: errorObj.stack,
          errorName: errorObj.name,
          messageCount: batch.messages.length,
        },
        'Unhandled error in queue processor',
      );

      metrics.counter('queue.unhandled_error', 1);
      throw error; // Rethrow to trigger retry
    });
  }

  /**
   * Get the service factory
   * @returns Service factory
   */
  getServices(): ServiceFactory {
    return this.services;
  }
}

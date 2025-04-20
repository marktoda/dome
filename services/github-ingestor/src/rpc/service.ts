import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { Env } from '../types';
import { ServiceFactory } from '../services';
import { RpcHandlers } from './handlers';
import { logger, logError } from '../utils/logging';
import { metrics } from '../utils/metrics';
import {
  createRepositorySchema,
  updateRepositorySchema,
  listRepositoriesSchema,
  syncRepositorySchema,
  getRepositoryStatusSchema,
  installationSchema,
  listInstallationsSchema,
  getStatisticsSchema,
  repositoryIdentifierSchema
} from './schemas';

/**
 * RPC Service for the GitHub Ingestor
 * Provides methods for managing repository configurations and triggering syncs
 */
export class RpcService {
  private app: Hono;
  private handlers: RpcHandlers;

  /**
   * Create a new RPC service
   * @param services Service factory
   * @param env Environment
   */
  constructor(services: ServiceFactory, env: Env) {
    this.handlers = new RpcHandlers(services, env);
    this.app = this.createApp();
  }

  /**
   * Create the Hono app for handling RPC requests
   * @returns Hono app
   */
  private createApp(): Hono {
    const app = new Hono();

    // Middleware for logging and metrics
    app.use('*', async (c, next) => {
      const startTime = Date.now();
      const method = c.req.method;
      const path = new URL(c.req.url).pathname;

      logger.info({ method, path }, 'RPC request received');
      metrics.counter('rpc.request', 1, { method, path });

      try {
        await next();
      } catch (error) {
        logError(error as Error, 'Error in RPC request', { method, path });
        metrics.counter('rpc.error', 1, { method, path });

        return c.json({
          success: false,
          error: (error as Error).message
        }, 500);
      }

      metrics.timing('rpc.response_time_ms', Date.now() - startTime, { method, path });
    });

    // Repository management endpoints
    app.post('/repositories', zValidator('json', createRepositorySchema), async (c) => {
      const data = await c.req.json();
      const repository = await this.handlers.addRepository(data);
      return c.json({ success: true, data: repository });
    });

    app.put('/repositories/:id', zValidator('json', updateRepositorySchema), async (c) => {
      const id = c.req.param('id');
      const data = await c.req.json();

      // Ensure the ID in the path matches the ID in the body
      if (data.id && data.id !== id) {
        return c.json({
          success: false,
          error: 'ID in path does not match ID in body'
        }, 400);
      }

      // Set the ID from the path if not provided in the body
      const updateData = { ...data, id };

      const repository = await this.handlers.updateRepository(updateData);
      return c.json({ success: true, data: repository });
    });

    app.delete('/repositories/:id', async (c) => {
      const id = c.req.param('id');
      const result = await this.handlers.removeRepository(id);
      return c.json({ success: result.success });
    });

    app.get('/repositories/:id', async (c) => {
      const id = c.req.param('id');
      const repository = await this.handlers.getRepository(id);
      return c.json({ success: true, data: repository });
    });

    app.get('/repositories', zValidator('query', listRepositoriesSchema), async (c) => {
      const query = c.req.valid('query');
      const repositories = await this.handlers.listRepositories(query);
      return c.json({ success: true, data: repositories });
    });

    // Repository sync endpoints
    app.post('/repositories/:id/sync', zValidator('json', syncRepositorySchema), async (c) => {
      const id = c.req.param('id');
      const data = await c.req.json();

      // Ensure the ID in the path matches the ID in the body
      if (data.id && data.id !== id) {
        return c.json({
          success: false,
          error: 'ID in path does not match ID in body'
        }, 400);
      }

      // Set the ID from the path if not provided in the body
      const syncData = { ...data, id };

      const result = await this.handlers.syncRepository(syncData);
      return c.json({ success: result.success });
    });

    app.get('/repositories/:id/status', async (c) => {
      const id = c.req.param('id');
      const status = await this.handlers.getRepositoryStatus({ id });
      return c.json({ success: true, data: status });
    });

    // GitHub App installation endpoints
    app.post('/installations', zValidator('json', installationSchema), async (c) => {
      const data = await c.req.json();
      const installation = await this.handlers.addInstallation(data);
      return c.json({ success: true, data: installation });
    });

    app.get('/installations', zValidator('query', listInstallationsSchema), async (c) => {
      const query = c.req.valid('query');
      const installations = await this.handlers.listInstallations(query);
      return c.json({ success: true, data: installations });
    });

    app.delete('/installations/:id', async (c) => {
      const id = c.req.param('id');
      const result = await this.handlers.removeInstallation(id);
      return c.json({ success: result.success });
    });

    // Statistics endpoints
    app.get('/statistics', zValidator('query', getStatisticsSchema), async (c) => {
      const query = c.req.valid('query');
      const statistics = await this.handlers.getStatistics(query);
      return c.json({ success: true, data: statistics });
    });

    // Catch-all for other routes
    app.all('*', (c) => {
      return c.json({ success: false, error: 'Not found' }, 404);
    });

    return app;
  }

  /**
   * Handle RPC requests
   * @param request HTTP request
   * @returns HTTP response
   */
  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}

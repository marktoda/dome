import { Context } from 'hono';
import { getLogger } from '@dome/logging';
import { TsunamiClient } from '@dome/tsunami/client';
import { Bindings } from '../types';
import { UserIdContext } from '../middleware/userIdMiddleware';
import { z } from 'zod';

/**
 * Tsunami controller for managing GitHub repository syncing
 */
export class TsunamiController {
  private logger = getLogger().child({ component: 'TsunamiController' });

  /**
   * Create a new TsunamiController
   * @param tsunamiService Tsunami service instance
   */
  constructor(private readonly tsunamiService: TsunamiClient) {
    this.logger.debug('Creating new TsunamiController instance');
  }

  /**
   * Register a GitHub repository
   *
   * @param c Hono context
   * @returns Response
   */
  async registerGithubRepo(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) {
    try {
      const schema = z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        userId: z.string().optional(),
        cadence: z.string().default('PT1H')
      });

      const { owner, repo, userId, cadence } = await c.req.json<z.infer<typeof schema>>();
      this.logger.info(
        { owner, repo, userId, cadence },
        'Registering GitHub repository'
      );

      // Convert cadence string (e.g., "PT1H") to seconds if provided
      let cadenceSecs = 3600; // Default 1 hour
      if (cadence) {
        // Simple cadence string parsing (PT1H = 1 hour)
        const match = cadence.match(/PT(\d+)([HMS])/);
        if (match) {
          const value = parseInt(match[1], 10);
          const unit = match[2];

          if (unit === 'H') cadenceSecs = value * 3600;
          else if (unit === 'M') cadenceSecs = value * 60;
          else if (unit === 'S') cadenceSecs = value;
        }
      }

      const result = await this.tsunamiService.registerGithubRepo(owner, repo, userId, cadenceSecs);

      this.logger.info(
        { id: result.id, resourceId: result.resourceId, wasInitialised: result.wasInitialised },
        'GitHub repository registered successfully'
      );

      return c.json({
        success: true,
        ...result
      });
    } catch (error) {
      this.logger.error({ error }, 'Error registering GitHub repository');
      throw error;
    }
  }

  /**
   * Get history for a GitHub repository
   *
   * @param c Hono context
   * @returns Response
   */
  async getGithubRepoHistory(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) {
    try {
      const { owner, repo } = c.req.param();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info(
        { owner, repo, limit },
        'Getting GitHub repository history'
      );

      const result = await this.tsunamiService.getGithubRepoHistory(owner, repo, limit);

      this.logger.info(
        { owner, repo, historyCount: result.history.length },
        'GitHub repository history retrieved successfully'
      );

      return c.json({
        success: true,
        ...result
      });
    } catch (error) {
      this.logger.error({ error }, 'Error retrieving GitHub repository history');
      throw error;
    }
  }

  /**
   * Get sync history for a user
   *
   * @param c Hono context
   * @returns Response
   */
  async getUserHistory(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) {
    try {
      const { userId } = c.req.param();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info(
        { userId, limit },
        'Getting user sync history'
      );

      const result = await this.tsunamiService.getUserHistory(userId, limit);

      this.logger.info(
        { userId, historyCount: result.history.length },
        'User sync history retrieved successfully'
      );

      return c.json({
        success: true,
        ...result
      });
    } catch (error) {
      this.logger.error({ error }, 'Error retrieving user sync history');
      throw error;
    }
  }

  /**
   * Get history for a sync plan
   *
   * @param c Hono context
   * @returns Response
   */
  async getSyncPlanHistory(c: Context<{ Bindings: Bindings; Variables: UserIdContext }>) {
    try {
      const { syncPlanId } = c.req.param();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info(
        { syncPlanId, limit },
        'Getting sync plan history'
      );

      const result = await this.tsunamiService.getSyncPlanHistory(syncPlanId, limit);

      this.logger.info(
        { syncPlanId, historyCount: result.history.length },
        'Sync plan history retrieved successfully'
      );

      return c.json({
        success: true,
        ...result
      });
    } catch (error) {
      this.logger.error({ error }, 'Error retrieving sync plan history');
      throw error;
    }
  }
}

import { Context } from 'hono';
import { getIdentity, getLogger } from '@dome/common';
import { TsunamiClient } from '@dome/tsunami/client';
import { Bindings } from '../types';
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
  async registerGithubRepo(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity();
      const schema = z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        cadence: z.string().default('PT1H'),
      });

      const { owner, repo, cadence } = await c.req.json<z.infer<typeof schema>>();
      this.logger.info({ owner, repo, userId, cadence }, 'Registering GitHub repository');

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
        'GitHub repository registered successfully',
      );

      return c.json({
        success: true,
        ...result,
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
  async getGithubRepoHistory(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity();
      const { owner, repo } = c.req.param();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info({ owner, repo, limit }, 'Getting GitHub repository history');

      const result = await this.tsunamiService.getGithubRepoHistory(owner, repo, limit);

      this.logger.info(
        { owner, repo, historyCount: result.history.length },
        'GitHub repository history retrieved successfully',
      );

      return c.json({
        success: true,
        ...result,
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
  async getUserHistory(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info({ userId, limit }, 'Getting user sync history');

      const result = await this.tsunamiService.getUserHistory(userId, limit);

      this.logger.info(
        { userId, historyCount: result.history.length },
        'User sync history retrieved successfully',
      );

      return c.json({
        success: true,
        ...result,
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
  async getSyncPlanHistory(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity();
      const { syncPlanId } = c.req.param();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info({ syncPlanId, limit }, 'Getting sync plan history');

      const result = await this.tsunamiService.getSyncPlanHistory(syncPlanId, limit);

      this.logger.info(
        { syncPlanId, historyCount: result.history.length },
        'Sync plan history retrieved successfully',
      );

      return c.json({
        success: true,
        ...result,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error retrieving sync plan history');
      throw error;
    }
  }

  /**
   * Stores GitHub OAuth integration details (access token, user info).
   * Called by the UI after it completes the OAuth token exchange with GitHub.
   *
   * @param c Hono context
   * @returns Response
   */
  async storeGithubIntegration(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity(); // User ID from your application's auth system
      const schema = z.object({
        accessToken: z.string().min(1),
        scope: z.string().optional(),
        tokenType: z.string().optional(),
        // Details fetched from GitHub's /user endpoint
        githubUserId: z.number().int(), // Or string, depending on how GitHub API returns it
        githubUsername: z.string().min(1),
        // Optional fields if provided by GitHub's token response
        // refreshToken: z.string().optional(),
        // expiresIn: z.number().int().optional(),
      });

      const payload = await c.req.json<z.infer<typeof schema>>();

      this.logger.info(
        { githubUsername: payload.githubUsername, appUserId: userId },
        'Storing GitHub integration details via Tsunami service',
      );

      // TODO: Implement storeGithubOAuthDetails in TsunamiClient and Tsunami service
      /*
      const tsunamiResult = await this.tsunamiService.storeGithubOAuthDetails({
        userId, // App user ID
        accessToken: payload.accessToken,
        scope: payload.scope,
        tokenType: payload.tokenType,
        providerAccountId: payload.githubUserId.toString(), // Store GitHub user ID as providerAccountId
        metadata: JSON.stringify({
          username: payload.githubUsername,
          // Potentially other GitHub user details if needed
        }),
        // refreshToken: payload.refreshToken,
        // expiresAt: payload.expiresIn ? Math.floor(Date.now() / 1000) + payload.expiresIn : undefined,
      });

      if (!tsunamiResult || !tsunamiResult.success) {
        this.logger.error({ tsunamiResult, githubUsername: payload.githubUsername, appUserId: userId }, 'Failed to store GitHub integration details via Tsunami service');
        return c.json({
          success: false,
          message: 'Failed to store GitHub integration with backend service.',
        }, 500);
      }
      */

      this.logger.info(
        { githubUsername: payload.githubUsername, appUserId: userId /*, tsunamiResult */ },
        'GitHub integration details successfully received (Tsunami storage pending).',
      );

      return c.json({
        success: true,
        message: 'GitHub integration details received (mocked storage).',
        githubUsername: payload.githubUsername,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error storing GitHub integration details');
      throw error; // Let the global error handler manage the response
    }
  }
}

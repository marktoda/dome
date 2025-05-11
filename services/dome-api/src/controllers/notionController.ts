import { Context } from 'hono';
import { getIdentity, getLogger } from '@dome/common';
import { TsunamiClient } from '@dome/tsunami/client';
import { Bindings } from '../types';
import { z } from 'zod';

/**
 * Notion controller for managing Notion workspace syncing
 */
export class NotionController {
  private logger = getLogger().child({ component: 'NotionController' });

  /**
   * Create a new NotionController
   * @param tsunamiService Tsunami service instance
   */
  constructor(private readonly tsunamiService: TsunamiClient) {
    this.logger.debug('Creating new NotionController instance');
  }

  /**
   * Register a Notion workspace
   *
   * @param c Hono context
   * @returns Response
   */
  async registerNotionWorkspace(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity();
      const schema = z.object({
        workspaceId: z.string().min(1),
        userId: z.string().optional(),
        cadence: z.string().default('PT1H'),
      });

      const { workspaceId, cadence } = await c.req.json<z.infer<typeof schema>>();
      this.logger.info({ workspaceId, userId, cadence }, 'Registering Notion workspace');

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

      const result = await this.tsunamiService.registerNotionWorkspace(
        workspaceId,
        userId,
        cadenceSecs,
      );

      this.logger.info(
        { id: result.id, resourceId: result.resourceId, wasInitialised: result.wasInitialised },
        'Notion workspace registered successfully',
      );

      return c.json({
        success: true,
        ...result,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error registering Notion workspace');
      throw error;
    }
  }

  /**
   * Get history for a Notion workspace
   *
   * @param c Hono context
   * @returns Response
   */
  async getNotionWorkspaceHistory(c: Context<{ Bindings: Bindings }>) {
    try {
      const { workspaceId } = c.req.param();
      const limit = parseInt(c.req.query('limit') || '10', 10);

      this.logger.info({ workspaceId, limit }, 'Getting Notion workspace history');

      const result = await this.tsunamiService.getNotionWorkspaceHistory(workspaceId, limit);

      this.logger.info(
        { workspaceId, historyCount: result.history.length },
        'Notion workspace history retrieved successfully',
      );

      return c.json({
        success: true,
        ...result,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error retrieving Notion workspace history');
      throw error;
    }
  }

  /**
   * Manually trigger a sync for a Notion workspace
   *
   * @param c Hono context
   * @returns Response
   */
  async triggerNotionWorkspaceSync(c: Context<{ Bindings: Bindings }>) {
    try {
      const { workspaceId } = c.req.param();

      this.logger.info({ workspaceId }, 'Triggering Notion workspace sync');

      // For a real implementation, we would call a method on tsunamiService
      // This would need to be implemented in the Tsunami service
      // For now, we'll return a placeholder response

      return c.json({
        success: true,
        message: 'Notion workspace sync has been triggered',
        workspaceId,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error triggering Notion workspace sync');
      throw error;
    }
  }

  /**
   * Configure OAuth for Notion
   *
   * @param c Hono context
   * @returns Response
   */
  async configureNotionOAuth(c: Context<{ Bindings: Bindings }>) {
    try {
      const schema = z.object({
        code: z.string().min(1),
        redirectUri: z.string().url(),
      });
      const { userId } = getIdentity();

      const { code, redirectUri } = await c.req.json<z.infer<typeof schema>>();

      this.logger.info({ codeExists: !!code, redirectUri, userId }, 'Configuring Notion OAuth');

      // In a real implementation, we would exchange the code for a token
      // and then use that token to access the Notion API
      // For now, we'll return a placeholder response

      return c.json({
        success: true,
        message: 'Notion OAuth configured successfully',
        userId,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error configuring Notion OAuth');
      throw error;
    }
  }

  /**
   * Get OAuth URL for Notion
   *
   * @param c Hono context
   * @returns Response
   */
  async getNotionOAuthUrl(c: Context<{ Bindings: Bindings }>) {
    try {
      const schema = z.object({
        redirectUri: z.string().url(),
        state: z.string().optional(),
      });

      const { redirectUri, state } = await c.req.json<z.infer<typeof schema>>();

      this.logger.info({ redirectUri, state }, 'Getting Notion OAuth URL');

      // In a real implementation, we would generate a proper OAuth URL
      // For now, we'll return a placeholder response

      // Example Notion OAuth URL structure (not for production use)
      const notionOAuthUrl = `https://api.notion.com/v1/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&response_type=code${state ? `&state=${state}` : ''}`;

      return c.json({
        success: true,
        url: notionOAuthUrl,
      });
    } catch (error) {
      this.logger.error({ error }, 'Error getting Notion OAuth URL');
      throw error;
    }
  }

  /**
   * Stores Notion OAuth integration details (access token, workspace info).
   * Called by the UI after it completes the OAuth token exchange with Notion.
   *
   * @param c Hono context
   * @returns Response
   */
  async storeNotionIntegration(c: Context<{ Bindings: Bindings }>) {
    try {
      const { userId } = getIdentity();
      const schema = z.object({
        accessToken: z.string().min(1),
        workspaceId: z.string().min(1),
        workspaceName: z.string().nullable().optional(),
        workspaceIcon: z.string().url().nullable().optional(),
        botId: z.string().min(1),
        // The 'owner' object from Notion can be complex (user or integration).
        // We might simplify what we store or pass it through if tsunami handles it.
        // For now, let's assume tsunami might want the raw owner object or specific parts.
        owner: z.any().optional(),
        duplicatedTemplateId: z.string().nullable().optional(),
      });

      const payload = await c.req.json<z.infer<typeof schema>>();

      this.logger.info(
        { workspaceId: payload.workspaceId, userId, botId: payload.botId },
        'Storing Notion integration details via Tsunami service',
      );

      // Call the Tsunami service to store the Notion OAuth details.
      // The TsunamiClient's storeNotionOAuthDetails method will internally call the
      // Tsunami worker entrypoint, which then uses TokenService to store in D1.
      const tsunamiResult = await this.tsunamiService.storeNotionOAuthDetails({
        userId, // This needs to be the actual authenticated user's ID
        accessToken: payload.accessToken,
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        workspaceIcon: payload.workspaceIcon,
        botId: payload.botId,
        owner: payload.owner,
        duplicatedTemplateId: payload.duplicatedTemplateId,
      });

      if (!tsunamiResult || !tsunamiResult.success) {
        this.logger.error(
          { tsunamiResult, workspaceId: payload.workspaceId, userId },
          'Failed to store Notion integration details via Tsunami service',
        );
        // Consider throwing a specific error or returning a more detailed error response
        return c.json(
          {
            success: false,
            message: 'Failed to store Notion integration with backend service.',
            workspaceId: payload.workspaceId,
          },
          500,
        );
      }

      this.logger.info(
        { workspaceId: payload.workspaceId, userId, tsunamiResult },
        'Notion integration details successfully stored via Tsunami service.',
      );

      return c.json({
        success: true,
        message: 'Notion integration successfully stored.',
        workspaceId: payload.workspaceId,
        details: tsunamiResult, // Optionally return details from Tsunami
      });
    } catch (error) {
      this.logger.error({ error }, 'Error storing Notion integration details');
      throw error; // Let the global error handler manage the response
    }
  }
}

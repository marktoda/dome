/**
 * Chat Orchestrator Service
 *
 * This is the main entry point for the Chat Orchestrator service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing using Hono for routing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { getLogger, logError } from '@dome/common';
import { createServices } from './services';
import { createControllers } from './controllers';
import { ChatBinding } from './client';
import { ChatRequest } from './types';

export * from './client';

/**
 * Chat Orchestrator service main class
 */
export default class Chat extends WorkerEntrypoint<Env> implements ChatBinding {
  private services;
  private controllers;
  private app: Hono;
  private logger = getLogger().child({ component: 'Chat' });

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);

    // Initialize services and controllers
    this.services = createServices(env);
    this.controllers = createControllers(env, this.services, ctx);

    // Create Hono app instance
    this.app = new Hono();

    this.app.post('/stream', async c => {
      // Parse once, Hono does *not* auto-parse JSON for you
      const body = await c.req.json<ChatRequest>();

      // Ask the controller for the stream
      const stream = await this.controllers.chat.startChatSession(body);

      // Standard SSE headers; change Content-Type if you use ND-JSON, etc.
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.status(200);

      // Done.  c.body() also works, but returning Response is simplest.
      return new Response(stream);
    });

    this.app.get('/healthz', () => new Response('ok'));

    this.logger.info('Chat Orchestrator service initialized');
  }

  // ⭐ Central fetch: hand *all* HTTP traffic to Hono,
  // let WorkerEntrypoint take care of RPC calls (service bindings).
  async fetch(req: Request) {
    // Otherwise treat it as a normal HTTP request
    return this.app.fetch(req);
  }

  /**
   * Generate a chat message (non-streaming)
   * @param request Chat request
   * @returns Complete response with aggregated output
   */
  async generateChatMessage(request: ChatRequest): Promise<Response> {
    try {
      this.logger.info(
        {
          operation: 'generateChatMessage',
          userId: request?.userId,
        },
        'RPC call received',
      );

      // Delegate to the controller
      return await this.controllers.chat.generateChatMessage(request);
    } catch (error) {
      this.logger.error(
        {
          operation: 'generateChatMessage',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    try {
      this.logger.info(
        {
          operation: 'getCheckpointStats',
        },
        'RPC call received',
      );

      return await this.controllers.admin.getCheckpointStats();
    } catch (error) {
      this.logger.error(
        {
          operation: 'getCheckpointStats',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    try {
      this.logger.info(
        {
          operation: 'cleanupCheckpoints',
        },
        'RPC call received',
      );

      return await this.controllers.admin.cleanupCheckpoints();
    } catch (error) {
      this.logger.error(
        {
          operation: 'cleanupCheckpoints',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    try {
      this.logger.info(
        {
          operation: 'getDataRetentionStats',
        },
        'RPC call received',
      );

      return await this.controllers.admin.getDataRetentionStats();
    } catch (error) {
      this.logger.error(
        {
          operation: 'getDataRetentionStats',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    try {
      this.logger.info(
        {
          operation: 'cleanupExpiredData',
        },
        'RPC call received',
      );

      return await this.controllers.admin.cleanupExpiredData();
    } catch (error) {
      this.logger.error(
        {
          operation: 'cleanupExpiredData',
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    try {
      this.logger.info(
        {
          operation: 'deleteUserData',
          userId,
        },
        'RPC call received',
      );

      return await this.controllers.admin.deleteUserData(userId);
    } catch (error) {
      this.logger.error(
        {
          operation: 'deleteUserData',
          userId,
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }

  /**
   * Record user consent
   * @param userId User ID
   * @param dataCategory Data category
   * @param request Consent request
   * @returns Success result
   */
  async recordConsent(
    userId: string,
    dataCategory: string,
    request: { durationDays: number },
  ): Promise<{ success: boolean }> {
    try {
      this.logger.info(
        {
          operation: 'recordConsent',
          userId,
          dataCategory,
        },
        'RPC call received',
      );

      return await this.controllers.admin.recordConsent(userId, dataCategory, request);
    } catch (error) {
      this.logger.error(
        {
          operation: 'recordConsent',
          userId,
          dataCategory,
          error,
        },
        'Error in RPC call',
      );

      throw error;
    }
  }
}

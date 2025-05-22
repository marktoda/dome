/**
 * Chat Orchestrator Service
 *
 * This is the main entry point for the Chat Orchestrator service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing using Hono for routing.
 */

import { BaseWorker } from '@dome/common';
import { Hono } from 'hono';
import { errorHandler } from '@dome/common/errors';
import { createServices } from './services';
import { createControllers } from './controllers';
import { ChatBinding } from './client';
import { ChatRequest } from './types';

export * from './client';

/**
 * Chat Orchestrator service main class
 */
export default class Chat extends BaseWorker<Env, ReturnType<typeof createServices>> implements ChatBinding {
  private controllers;
  private app: Hono;

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env, createServices, { serviceName: 'chat' });

    // Initialize controllers using lazily created services
    this.controllers = createControllers(env, this.services, ctx);

    // Create Hono app instance
    this.app = new Hono();
    this.app.use('*', errorHandler());

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
    return this.wrap(
      { operation: 'generateChatMessage', userId: request?.userId },
      () => this.controllers.chat.generateChatMessage(request),
    );
  }

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    return this.wrap(
      { operation: 'getCheckpointStats' },
      () => this.controllers.admin.getCheckpointStats(),
    );
  }

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    return this.wrap(
      { operation: 'cleanupCheckpoints' },
      () => this.controllers.admin.cleanupCheckpoints(),
    );
  }

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    return this.wrap(
      { operation: 'getDataRetentionStats' },
      () => this.controllers.admin.getDataRetentionStats(),
    );
  }

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    return this.wrap(
      { operation: 'cleanupExpiredData' },
      () => this.controllers.admin.cleanupExpiredData(),
    );
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    return this.wrap(
      { operation: 'deleteUserData', userId },
      () => this.controllers.admin.deleteUserData(userId),
    );
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
    return this.wrap(
      { operation: 'recordConsent', userId, dataCategory },
      () => this.controllers.admin.recordConsent(userId, dataCategory, request),
    );
  }
}

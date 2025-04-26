/**
 * Chat Orchestrator Service
 *
 * This is the main entry point for the Chat Orchestrator service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger } from '@dome/logging';
import { createServices } from './services';
import { createControllers } from './controllers';
import { ChatOrchestratorBinding } from './client';
import { withErrorHandling } from './utils/errorHandler';

export * from './client';

/**
 * Chat Orchestrator service main class
 */
export default class ChatOrchestrator
  extends WorkerEntrypoint<Env>
  implements ChatOrchestratorBinding
{
  private services;
  private controllers;
  private logger = getLogger().child({ component: 'ChatOrchestrator' });

  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);

    // Initialize services and controllers
    this.services = createServices(env);
    this.controllers = createControllers(env, this.services);

    this.logger.info('Chat Orchestrator service initialized');
  }

  /**
   * Generate a chat response with streaming
   * @param request Chat request
   * @returns Streaming response
   */
  generateChatResponse = withErrorHandling(
    'generateChatResponse',
    async (request: any): Promise<Response> => {
      return await this.controllers.chat.generateChatResponse(request);
    }
  );

  /**
   * Resume a chat session
   * @param request Resume chat request
   * @returns Streaming response
   */
  resumeChatSession = withErrorHandling(
    'resumeChatSession',
    async (request: any): Promise<Response> => {
      return await this.controllers.chat.resumeChatSession(request);
    }
  );

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  getCheckpointStats = withErrorHandling(
    'getCheckpointStats',
    async (): Promise<any> => {
      return await this.controllers.admin.getCheckpointStats();
    }
  );

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  cleanupCheckpoints = withErrorHandling(
    'cleanupCheckpoints',
    async (): Promise<{ deletedCount: number }> => {
      return await this.controllers.admin.cleanupCheckpoints();
    }
  );

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  getDataRetentionStats = withErrorHandling(
    'getDataRetentionStats',
    async (): Promise<any> => {
      return await this.controllers.admin.getDataRetentionStats();
    }
  );

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  cleanupExpiredData = withErrorHandling(
    'cleanupExpiredData',
    async (): Promise<any> => {
      return await this.controllers.admin.cleanupExpiredData();
    }
  );

  /**
   * Delete user data
   * @param userId User ID
   * @returns Deletion result
   */
  deleteUserData = withErrorHandling(
    'deleteUserData',
    async (userId: string): Promise<{ deletedCount: number }> => {
      return await this.controllers.admin.deleteUserData(userId);
    }
  );

  /**
   * Record user consent
   * @param userId User ID
   * @param dataCategory Data category
   * @param request Consent request
   * @returns Success result
   */
  recordConsent = withErrorHandling(
    'recordConsent',
    async (
      userId: string,
      dataCategory: string,
      request: { durationDays: number },
    ): Promise<{ success: boolean }> => {
      return await this.controllers.admin.recordConsent(userId, dataCategory, request);
    }
  );
}

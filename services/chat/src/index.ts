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
  async generateChatResponse(request: any): Promise<Response> {
    try {
      this.logger.info({
        operation: 'generateChatResponse',
        userId: request?.userId,
      }, 'RPC call received');
      
      return await this.controllers.chat.generateChatResponse(request);
    } catch (error) {
      this.logger.error({
        operation: 'generateChatResponse',
        error,
      }, 'Error in RPC call');
      
      throw error;
    }
  }

  /**
   * Resume a chat session
   * @param request Resume chat request
   * @returns Streaming response
   */
  async resumeChatSession(request: any): Promise<Response> {
    try {
      this.logger.info({
        operation: 'resumeChatSession',
        runId: request?.runId,
      }, 'RPC call received');
      
      return await this.controllers.chat.resumeChatSession(request);
    } catch (error) {
      this.logger.error({
        operation: 'resumeChatSession',
        error,
      }, 'Error in RPC call');
      
      throw error;
    }
  }

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    try {
      this.logger.info({
        operation: 'getCheckpointStats',
      }, 'RPC call received');
      
      return await this.controllers.admin.getCheckpointStats();
    } catch (error) {
      this.logger.error({
        operation: 'getCheckpointStats',
        error,
      }, 'Error in RPC call');
      
      throw error;
    }
  }

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    try {
      this.logger.info({
        operation: 'cleanupCheckpoints',
      }, 'RPC call received');
      
      return await this.controllers.admin.cleanupCheckpoints();
    } catch (error) {
      this.logger.error({
        operation: 'cleanupCheckpoints',
        error,
      }, 'Error in RPC call');
      
      throw error;
    }
  }

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    try {
      this.logger.info({
        operation: 'getDataRetentionStats',
      }, 'RPC call received');
      
      return await this.controllers.admin.getDataRetentionStats();
    } catch (error) {
      this.logger.error({
        operation: 'getDataRetentionStats',
        error,
      }, 'Error in RPC call');
      
      throw error;
    }
  }

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    try {
      this.logger.info({
        operation: 'cleanupExpiredData',
      }, 'RPC call received');
      
      return await this.controllers.admin.cleanupExpiredData();
    } catch (error) {
      this.logger.error({
        operation: 'cleanupExpiredData',
        error,
      }, 'Error in RPC call');
      
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
      this.logger.info({
        operation: 'deleteUserData',
        userId,
      }, 'RPC call received');
      
      return await this.controllers.admin.deleteUserData(userId);
    } catch (error) {
      this.logger.error({
        operation: 'deleteUserData',
        userId,
        error,
      }, 'Error in RPC call');
      
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
      this.logger.info({
        operation: 'recordConsent',
        userId,
        dataCategory,
      }, 'RPC call received');
      
      return await this.controllers.admin.recordConsent(userId, dataCategory, request);
    } catch (error) {
      this.logger.error({
        operation: 'recordConsent',
        userId,
        dataCategory,
        error,
      }, 'Error in RPC call');
      
      throw error;
    }
  }
}

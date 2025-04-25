/**
 * Chat Orchestrator Service
 *
 * This is the main entry point for the Chat Orchestrator service, implementing a WorkerEntrypoint
 * class that handles both RPC methods and queue processing.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { getLogger, logError, metrics } from '@dome/logging';
import { createServices } from './services';
import { createControllers } from './controllers';
import { ChatOrchestratorBinding } from './client';

export * from './client';

/**
 * Chat Orchestrator service main class
 */
export default class ChatOrchestrator extends WorkerEntrypoint<Env> implements ChatOrchestratorBinding {
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
      return await this.controllers.chat.generateChatResponse(request);
    } catch (error) {
      logError(error, 'Unhandled error in generateChatResponse');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'generateChatResponse'
      });
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
      return await this.controllers.chat.resumeChatSession(request);
    } catch (error) {
      logError(error, 'Unhandled error in resumeChatSession');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'resumeChatSession'
      });
      throw error;
    }
  }

  /**
   * Get checkpoint statistics
   * @returns Checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    try {
      return await this.controllers.admin.getCheckpointStats();
    } catch (error) {
      logError(error, 'Unhandled error in getCheckpointStats');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'getCheckpointStats'
      });
      throw error;
    }
  }

  /**
   * Clean up expired checkpoints
   * @returns Cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    try {
      return await this.controllers.admin.cleanupCheckpoints();
    } catch (error) {
      logError(error, 'Unhandled error in cleanupCheckpoints');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'cleanupCheckpoints'
      });
      throw error;
    }
  }

  /**
   * Get data retention statistics
   * @returns Data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    try {
      return await this.controllers.admin.getDataRetentionStats();
    } catch (error) {
      logError(error, 'Unhandled error in getDataRetentionStats');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'getDataRetentionStats'
      });
      throw error;
    }
  }

  /**
   * Clean up expired data
   * @returns Cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    try {
      return await this.controllers.admin.cleanupExpiredData();
    } catch (error) {
      logError(error, 'Unhandled error in cleanupExpiredData');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'cleanupExpiredData'
      });
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
      return await this.controllers.admin.deleteUserData(userId);
    } catch (error) {
      logError(error, 'Unhandled error in deleteUserData');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'deleteUserData'
      });
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
    request: { durationDays: number }
  ): Promise<{ success: boolean }> {
    try {
      return await this.controllers.admin.recordConsent(userId, dataCategory, request);
    } catch (error) {
      logError(error, 'Unhandled error in recordConsent');
      metrics.increment('chat_orchestrator.unhandled_errors', 1, {
        operation: 'recordConsent'
      });
      throw error;
    }
  }
}

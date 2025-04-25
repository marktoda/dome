import { getLogger, withLogger, logError, metrics } from '@dome/logging';
import { AgentState } from '../types';
import { Env } from '../types/env';
import { z } from 'zod';

/**
 * Chat orchestrator client request interface
 */
export interface ChatOrchestratorRequest {
  initialState: {
    userId: string;
    messages: Array<{
      role: 'user' | 'assistant' | 'system';
      content: string;
      timestamp?: number;
    }>;
    enhanceWithContext?: boolean;
    maxContextItems?: number;
    includeSourceInfo?: boolean;
    maxTokens?: number;
    temperature?: number;
  };
  runId?: string;
}

/**
 * Chat orchestrator client response interface
 */
export interface ChatOrchestratorResponse {
  response: string;
  sources?: Array<{
    id: string;
    title: string;
    source: string;
    url?: string | null;
    relevanceScore: number;
  }>;
  metadata?: {
    executionTimeMs: number;
    nodeTimings: Record<string, number>;
    tokenCounts: Record<string, number>;
  };
}

/**
 * Chat orchestrator client for direct RPC communication
 */
export class ChatOrchestratorClient {
  private logger = getLogger().child({ component: 'ChatOrchestratorClient' });

  /**
   * Create a new chat orchestrator client
   * @param env Environment bindings with CHAT_ORCHESTRATOR service binding
   */
  constructor(private env: Env) {
    if (!env.CHAT_ORCHESTRATOR) {
      this.logger.warn('CHAT_ORCHESTRATOR binding not available');
    }
  }

  /**
   * Generate a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to the chat orchestrator response
   */
  async generateResponse(request: ChatOrchestratorRequest): Promise<ChatOrchestratorResponse> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'generateResponse',
      userId: request.initialState.userId,
      runId: request.runId,
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Start timing
        const startTime = performance.now();

        // Call the chat orchestrator directly via RPC
        const response = await this.env.CHAT_ORCHESTRATOR.generateChatResponse(request);

        // Process the streaming response to extract the generated text and sources
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('Response body is not readable');
        }

        let generatedText = '';
        const sources: any[] = [];
        let executionTimeMs = 0;

        // Read the SSE stream
        const textDecoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Decode the chunk and add it to the buffer
          buffer += textDecoder.decode(value, { stream: true });

          // Process complete SSE events in the buffer
          const events = buffer.split('\n\n');
          buffer = events.pop() || ''; // Keep the last incomplete event in the buffer

          for (const event of events) {
            if (!event.trim()) continue;

            const lines = event.split('\n');
            const eventType = lines[0].replace('event: ', '');
            const data = JSON.parse(lines[1].replace('data: ', ''));

            if (eventType === 'text' && data.text) {
              generatedText = data.text;
            } else if (eventType === 'sources' && Array.isArray(data)) {
              sources.push(...data);
            } else if (eventType === 'final' && data.executionTimeMs) {
              executionTimeMs = data.executionTimeMs;
            } else if (eventType === 'error' && data.message) {
              throw new Error(data.message);
            }
          }
        }

        // Create the response object
        const result: ChatOrchestratorResponse = {
          response: generatedText,
          sources: sources.length > 0 ? sources : undefined,
          metadata: {
            executionTimeMs: executionTimeMs || Math.round(performance.now() - startTime),
            nodeTimings: {},
            tokenCounts: {},
          },
        };

        this.logger.info(
          {
            userId: request.initialState.userId,
            responseLength: result.response?.length || 0,
            executionTimeMs: result.metadata?.executionTimeMs,
          },
          'Chat response generated successfully'
        );

        // Track metrics
        metrics.increment('chat_orchestrator_client.generate_response.success', 1);
        if (result.metadata?.executionTimeMs) {
          metrics.timing('chat_orchestrator_client.generate_response.duration_ms', result.metadata.executionTimeMs);
        }

        return result;
      } catch (error) {
        this.logger.error(
          {
            err: error,
            userId: request.initialState.userId,
          },
          'Error generating chat response via RPC'
        );

        // Track error metrics
        metrics.increment('chat_orchestrator_client.generate_response.error', 1, {
          errorType: error instanceof Error ? error.constructor.name : 'unknown'
        });

        throw error;
      }
    });
  }

  /**
   * Stream a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to a streaming response
   */
  async streamResponse(request: ChatOrchestratorRequest): Promise<Response> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'streamResponse',
      userId: request.initialState.userId,
      runId: request.runId,
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        const response = await this.env.CHAT_ORCHESTRATOR.generateChatResponse(request);

        this.logger.info(
          {
            userId: request.initialState.userId,
            status: response.status,
          },
          'Chat stream initiated successfully'
        );

        // Track metrics
        metrics.increment('chat_orchestrator_client.stream_response.success', 1);

        // Return the streaming response directly
        return response;
      } catch (error) {
        this.logger.error(
          {
            err: error,
            userId: request.initialState.userId,
          },
          'Error streaming chat response via RPC'
        );

        // Track error metrics
        metrics.increment('chat_orchestrator_client.stream_response.error', 1, {
          errorType: error instanceof Error ? error.constructor.name : 'unknown'
        });

        throw error;
      }
    });
  }

  /**
   * Resume a chat session
   * @param runId Run ID of the chat session to resume
   * @param newMessage Optional new message to add to the conversation
   * @returns Promise resolving to a streaming response
   */
  async resumeChatSession(
    runId: string,
    newMessage?: { role: 'user' | 'assistant' | 'system'; content: string; timestamp?: number }
  ): Promise<Response> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'resumeChatSession',
      runId,
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        const response = await this.env.CHAT_ORCHESTRATOR.resumeChatSession({
          runId,
          newMessage,
        });

        this.logger.info(
          {
            runId,
            status: response.status,
          },
          'Chat session resumed successfully'
        );

        // Track metrics
        metrics.increment('chat_orchestrator_client.resume_chat.success', 1);

        // Return the streaming response directly
        return response;
      } catch (error) {
        this.logger.error(
          {
            err: error,
            runId,
          },
          'Error resuming chat session via RPC'
        );

        // Track error metrics
        metrics.increment('chat_orchestrator_client.resume_chat.error', 1, {
          errorType: error instanceof Error ? error.constructor.name : 'unknown'
        });

        throw error;
      }
    });
  }

  /**
   * Get checkpoint statistics
   * @returns Promise resolving to checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'getCheckpointStats',
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        return await this.env.CHAT_ORCHESTRATOR.getCheckpointStats();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error getting checkpoint stats via RPC'
        );
        throw error;
      }
    });
  }

  /**
   * Clean up expired checkpoints
   * @returns Promise resolving to cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'cleanupCheckpoints',
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        return await this.env.CHAT_ORCHESTRATOR.cleanupCheckpoints();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error cleaning up checkpoints via RPC'
        );
        throw error;
      }
    });
  }

  /**
   * Get data retention statistics
   * @returns Promise resolving to data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'getDataRetentionStats',
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        return await this.env.CHAT_ORCHESTRATOR.getDataRetentionStats();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error getting data retention stats via RPC'
        );
        throw error;
      }
    });
  }

  /**
   * Clean up expired data
   * @returns Promise resolving to cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'cleanupExpiredData',
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        return await this.env.CHAT_ORCHESTRATOR.cleanupExpiredData();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error cleaning up expired data via RPC'
        );
        throw error;
      }
    });
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Promise resolving to deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'deleteUserData',
      userId,
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        return await this.env.CHAT_ORCHESTRATOR.deleteUserData(userId);
      } catch (error) {
        this.logger.error(
          { err: error, userId },
          'Error deleting user data via RPC'
        );
        throw error;
      }
    });
  }

  /**
   * Record user consent
   * @param userId User ID
   * @param dataCategory Data category
   * @param durationDays Duration in days
   * @returns Promise resolving to success result
   */
  async recordConsent(
    userId: string,
    dataCategory: string,
    durationDays: number
  ): Promise<{ success: boolean }> {
    return withLogger({
      component: 'ChatOrchestratorClient',
      operation: 'recordConsent',
      userId,
      dataCategory,
    }, async () => {
      try {
        if (!this.env.CHAT_ORCHESTRATOR) {
          throw new Error('CHAT_ORCHESTRATOR binding not available');
        }

        // Call the chat orchestrator directly via RPC
        return await this.env.CHAT_ORCHESTRATOR.recordConsent(
          userId,
          dataCategory,
          { durationDays }
        );
      } catch (error) {
        this.logger.error(
          { err: error, userId, dataCategory },
          'Error recording user consent via RPC'
        );
        throw error;
      }
    });
  }
}

/**
 * Chat Orchestrator Client
 *
 * This file exports a type-safe client for interacting with the Chat Orchestrator service.
 * It provides methods for all Chat Orchestrator operations and handles error logging, metrics, and validation.
 */

import { getLogger, withLogger, logError, metrics } from '@dome/logging';
import { ChatOrchestratorBinding, ChatRequest, chatRequestSchema, ResumeChatRequest } from '.';
import { z } from 'zod';

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
export class ChatClient {
  /**
   * Create a new chat orchestrator client
   * @param binding The Cloudflare Worker binding to the Chat Orchestrator service
   * @param metricsPrefix Optional prefix for metrics (defaults to 'chat_orchestrator.client')
   */
  constructor(
    private readonly binding: ChatOrchestratorBinding,
    private readonly metricsPrefix: string = 'chat_orchestrator.client',
  ) {}

  /**
   * Generate a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to the chat orchestrator response
   */
  async generateResponse(request: ChatRequest): Promise<ChatOrchestratorResponse> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'generateResponse',
        userId: request.userId,
        runId: request.runId,
      },
      async () => {
        try {
          // Validate request
          const validatedRequest = chatRequestSchema.parse(request);

          // Call the chat orchestrator directly via RPC
          const response = await this.binding.generateChatResponse(validatedRequest);

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

          getLogger().info(
            {
              userId: request.userId,
              responseLength: result.response?.length || 0,
              executionTimeMs: result.metadata?.executionTimeMs,
            },
            'Chat response generated successfully',
          );

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.generate_response.success`, 1);
          if (result.metadata?.executionTimeMs) {
            metrics.timing(
              `${this.metricsPrefix}.generate_response.duration_ms`,
              result.metadata.executionTimeMs,
            );
          }

          return result;
        } catch (error) {
          logError(error, 'Error generating chat response via RPC', {
            userId: request.userId,
          });

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.generate_response.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Stream a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to a streaming response
   */
  async streamResponse(request: ChatRequest): Promise<Response> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'streamResponse',
        userId: request.userId,
        runId: request.runId,
      },
      async () => {
        try {
          // Validate request
          const validatedRequest = chatRequestSchema.parse(request);

          // Call the chat orchestrator directly via RPC
          const response = await this.binding.generateChatResponse(validatedRequest);

          getLogger().info(
            {
              userId: request.userId,
              status: response.status,
            },
            'Chat stream initiated successfully',
          );

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.stream_response.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.stream_response.latency_ms`,
            performance.now() - startTime,
          );

          // Return the streaming response directly
          return response;
        } catch (error) {
          logError(error, 'Error streaming chat via RPC', { userId: request.userId });

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.stream_response.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Resume a chat session
   * @param runId Run ID of the chat session to resume
   * @param newMessage Optional new message to add to the conversation
   * @returns Promise resolving to a streaming response
   */
  async resumeChatSession(request: ResumeChatRequest): Promise<Response> {
    const startTime = performance.now();
    const { runId, newMessage } = request;

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'resumeChatSession',
        runId,
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const response = await this.binding.resumeChatSession({
            runId,
            newMessage,
          });

          getLogger().info(
            {
              runId,
              status: response.status,
            },
            'Chat session resumed successfully',
          );

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.resume_chat.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.resume_chat.latency_ms`,
            performance.now() - startTime,
          );

          // Return the streaming response directly
          return response;
        } catch (error) {
          logError(error, 'Error resuming chat session via RPC', { runId });

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.resume_chat.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Get checkpoint statistics
   * @returns Promise resolving to checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'getCheckpointStats',
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const result = await this.binding.getCheckpointStats();

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.get_checkpoint_stats.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.get_checkpoint_stats.latency_ms`,
            performance.now() - startTime,
          );

          return result;
        } catch (error) {
          logError(error, 'Error getting checkpoint stats via RPC');

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.get_checkpoint_stats.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Clean up expired checkpoints
   * @returns Promise resolving to cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'cleanupCheckpoints',
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const result = await this.binding.cleanupCheckpoints();

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.cleanup_checkpoints.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.cleanup_checkpoints.latency_ms`,
            performance.now() - startTime,
          );

          return result;
        } catch (error) {
          logError(error, 'Error cleaning up checkpoints via RPC');

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.cleanup_checkpoints.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Get data retention statistics
   * @returns Promise resolving to data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'getDataRetentionStats',
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const result = await this.binding.getDataRetentionStats();

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.get_data_retention_stats.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.get_data_retention_stats.latency_ms`,
            performance.now() - startTime,
          );

          return result;
        } catch (error) {
          logError(error, 'Error getting data retention stats via RPC');

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.get_data_retention_stats.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Clean up expired data
   * @returns Promise resolving to cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'cleanupExpiredData',
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const result = await this.binding.cleanupExpiredData();

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.cleanup_expired_data.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.cleanup_expired_data.latency_ms`,
            performance.now() - startTime,
          );

          return result;
        } catch (error) {
          logError(error, 'Error cleaning up expired data via RPC');

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.cleanup_expired_data.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Promise resolving to deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'deleteUserData',
        userId,
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const result = await this.binding.deleteUserData(userId);

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.delete_user_data.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.delete_user_data.latency_ms`,
            performance.now() - startTime,
          );

          return result;
        } catch (error) {
          logError(error, 'Error deleting user data via RPC', { userId });

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.delete_user_data.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
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
    durationDays: number,
  ): Promise<{ success: boolean }> {
    const startTime = performance.now();

    return withLogger(
      {
        component: 'ChatClient',
        operation: 'recordConsent',
        userId,
        dataCategory,
      },
      async () => {
        try {
          // Call the chat orchestrator directly via RPC
          const result = await this.binding.recordConsent(userId, dataCategory, { durationDays });

          // Track metrics
          metrics.increment(`${this.metricsPrefix}.record_consent.success`, 1);
          metrics.timing(
            `${this.metricsPrefix}.record_consent.latency_ms`,
            performance.now() - startTime,
          );

          return result;
        } catch (error) {
          logError(error, 'Error recording user consent via RPC', { userId, dataCategory });

          // Track error metrics
          metrics.increment(`${this.metricsPrefix}.record_consent.errors`, 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          throw error;
        }
      },
    );
  }
}

/**
 * Create a new ChatClient
 * @param binding The Cloudflare Worker binding to the Chat Orchestrator service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'chat_orchestrator.client')
 * @returns A new ChatClient instance
 */
export function createChatClient(
  binding: ChatOrchestratorBinding,
  metricsPrefix?: string,
): ChatClient {
  return new ChatClient(binding, metricsPrefix);
}

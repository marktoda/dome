/**
 * Chat Orchestrator Client
 *
 * This file exports a type-safe client for interacting with the Chat Orchestrator service.
 * It provides methods for all Chat Orchestrator operations and handles error logging, metrics, and validation.
 */

import { getLogger, logError, metrics } from '@dome/common';
import { ChatBinding, ChatRequest, chatRequestSchema, ResumeChatRequest } from '.';
import { SourceMetadata } from '../types';
import { z } from 'zod';

/**
 * Chat orchestrator client response interface
 */
export interface ChatResponse {
  response: string;
  sources?: SourceMetadata[];
  metadata?: ResponseMetadata;
}

/**
 * Server response type definition matching the API schema
 * This ensures type parity between client and server responses
 */
export interface ResponseMetadata {
  executionTimeMs: number;
  nodeTimings: Record<string, number>;
  tokenCounts: Record<string, number>;
}

/**
 * Server response metadata with optional fields
 * Used specifically by ChatServerResponse
 */
export interface ServerResponseMetadata {
  executionTimeMs?: number;
  nodeTimings?: Record<string, number>;
  tokenCounts?: Record<string, number>;
}

/**
 * Standardized server response type definition
 * This ensures type parity between client and server responses
 */
export interface ChatServerResponse {
  generatedText: string;
  sources?: SourceMetadata[];
  metadata?: ServerResponseMetadata;
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
    private readonly binding: ChatBinding,
    private readonly metricsPrefix: string = 'chat_orchestrator.client',
  ) {}

  /**
   * Stream a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to a streaming response
   */
  async streamResponse(request: ChatRequest): Promise<Response> {
    const resp = await this.binding.fetch(
      new Request('https://chat.internal/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
    return resp; // a streaming HTTP Response
  }

  /**
   * Generate a chat response (non-streaming)
   * @param request Chat orchestrator request
   * @returns Promise resolving to the complete response
   */
  async generateDirectResponse(request: ChatRequest): Promise<ChatResponse> {
    const startTime = performance.now();

    try {
      // Validate request
      const validatedRequest = chatRequestSchema.parse(request);

      // Call the non-streaming chat endpoint via RPC
      const response = await this.binding.generateChatMessage(validatedRequest);

      // Collect header keys without using keys() method
      const headerKeys: string[] = [];
      response.headers.forEach((_, key) => {
        headerKeys.push(key);
      });

      getLogger().info(
        {
          status: response.status,
          statusText: response.statusText,
          headerKeys: headerKeys,
          isBodyUsed: response.bodyUsed,
          response,
        },
        '[ChatClient]: Non-streaming chat response received',
      );

      if (!response.ok) {
        throw new Error(
          `Failed to generate chat message: ${response.status} ${response.statusText}`,
        );
      }

      // Clone the response before parsing to enable safer debugging
      const responseClone = response.clone();

      try {
        // Parse the JSON response using the defined type
        const responseData = (await response.json()) as ChatServerResponse;
        getLogger().info(
          {
            responseDataKeys: Object.keys(responseData),
            hasGeneratedText: !!responseData.generatedText,
            generatedTextLength: responseData.generatedText?.length || 0,
          },
          '[ChatClient]: Successfully parsed response JSON',
        );

        // Create the response object using standardized types
        const result: ChatResponse = {
          response: responseData.generatedText || '',
          sources: responseData.sources,
          metadata: {
            executionTimeMs:
              responseData.metadata?.executionTimeMs || Math.round(performance.now() - startTime),
            nodeTimings: responseData.metadata?.nodeTimings || {},
            tokenCounts: responseData.metadata?.tokenCounts || {},
          },
        };

        // Log the response
        getLogger().info(
          {
            userId: request.userId,
            responseLength: result.response?.length || 0,
            executionTimeMs: result.metadata?.executionTimeMs,
          },
          'Non-streaming chat response generated successfully',
        );

        // Track metrics
        metrics.increment(`${this.metricsPrefix}.generate_direct_response.success`, 1);
        if (result.metadata?.executionTimeMs) {
          metrics.timing(
            `${this.metricsPrefix}.generate_direct_response.duration_ms`,
            result.metadata.executionTimeMs,
          );
        }

        return result;
      } catch (parseError) {
        // If JSON parsing fails, attempt to get response text for better debugging
        getLogger().error({ error: parseError }, '[ChatClient]: Failed to parse JSON response');

        try {
          // Try to get the raw text to see what went wrong
          const rawText = await responseClone.text();
          getLogger().error(
            { rawText, rawTextLength: rawText.length },
            '[ChatClient]: Raw response text',
          );

          // Attempt to recover if there's actual text in the response
          if (rawText && rawText.length > 0 && rawText !== '{}') {
            const fallbackResult = {
              response: rawText,
              metadata: {
                executionTimeMs: Math.round(performance.now() - startTime),
                nodeTimings: {},
                tokenCounts: {},
              },
            };

            getLogger().info('Recovered using raw text response');
            metrics.increment(`${this.metricsPrefix}.generate_direct_response.recovery`, 1);

            return fallbackResult;
          }
        } catch (textError) {
          getLogger().error({ error: textError }, '[ChatClient]: Failed to get response text');
        }

        // If all else fails, provide a fallback response
        // Handle the error properly with type checking
        const errorMessage =
          parseError instanceof Error ? parseError.message : 'Unknown parsing error';

        throw new Error(`Failed to parse chat response: ${errorMessage}`);
      }
    } catch (error) {
      logError(error, 'Error generating non-streaming chat response via RPC', {
        userId: request.userId,
      });

      // Track error metrics
      metrics.increment(`${this.metricsPrefix}.generate_direct_response.errors`, 1, {
        errorType: error instanceof Error ? error.constructor.name : 'unknown',
      });

      throw error;
    }
  }

  /**
   * Get checkpoint statistics
   * @returns Promise resolving to checkpoint statistics
   */
  async getCheckpointStats(): Promise<any> {
    const startTime = performance.now();

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
  }

  /**
   * Clean up expired checkpoints
   * @returns Promise resolving to cleanup result
   */
  async cleanupCheckpoints(): Promise<{ deletedCount: number }> {
    const startTime = performance.now();

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
  }

  /**
   * Get data retention statistics
   * @returns Promise resolving to data retention statistics
   */
  async getDataRetentionStats(): Promise<any> {
    const startTime = performance.now();

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
  }

  /**
   * Clean up expired data
   * @returns Promise resolving to cleanup result
   */
  async cleanupExpiredData(): Promise<any> {
    const startTime = performance.now();

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
  }

  /**
   * Delete user data
   * @param userId User ID
   * @returns Promise resolving to deletion result
   */
  async deleteUserData(userId: string): Promise<{ deletedCount: number }> {
    const startTime = performance.now();

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
  }
}

/**
 * Create a new ChatClient
 * @param binding The Cloudflare Worker binding to the Chat Orchestrator service
 * @param metricsPrefix Optional prefix for metrics (defaults to 'chat_orchestrator.client')
 * @returns A new ChatClient instance
 */
export function createChatClient(binding: ChatBinding, metricsPrefix?: string): ChatClient {
  return new ChatClient(binding, metricsPrefix);
}

/**
 * Chat Orchestrator Client
 *
 * This file exports a type-safe client for interacting with the Chat Orchestrator service.
 * It provides methods for all Chat Orchestrator operations and handles error logging, metrics, and validation.
 */

import { getLogger, logError, metrics } from '@dome/logging';
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
  ) { }

  /**
   * Generate a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to the chat orchestrator response
   */
  async generateResponse(request: ChatRequest): Promise<ChatResponse> {
    const startTime = performance.now();

    try {
      // Validate request
      const validatedRequest = chatRequestSchema.parse(request);

      // Call the chat orchestrator directly via RPC
      const response = await this.binding.generateChatResponse(validatedRequest);
      getLogger().info('[ChatClient]: Chat response received');

      // Process the streaming response to extract the generated text and sources
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }
      getLogger().info('[ChatClient]: Reader available');

      let generatedText = '';
      const sources: any[] = [];
      let executionTimeMs = 0;
      let rawChunks: string[] = [];

      // Read the stream directly
      const textDecoder = new TextDecoder();
      let buffer = '';
      let totalBytesRead = 0;

      try {
        // Collect all chunks first
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            getLogger().info('[ChatClient]: End of stream reached');
            break;
          }

          // Log every single chunk as it comes in
          const chunk = textDecoder.decode(value, { stream: true });
          totalBytesRead += value.length;

          getLogger().info({
            chunkLength: chunk.length,
            chunkPreview: chunk.substring(0, 100),
            totalBytesRead
          }, '[ChatClient]: Received chunk');

          rawChunks.push(chunk);
          buffer += chunk;
        }

        // Log the entire buffer for debugging
        getLogger().info({
          bufferLength: buffer.length,
          bufferPreview: buffer.substring(0, 200)
        }, '[ChatClient]: Complete buffer received');

        // First attempt: Try to parse as SSE events
        const events = buffer.split('\n\n');
        getLogger().info({ eventCount: events.length }, '[ChatClient]: Split buffer into events');

        let foundText = false;

        // Process each event
        for (const event of events) {
          if (!event.trim()) continue;

          // Log each event
          getLogger().info({
            eventLength: event.length,
            eventPreview: event.substring(0, 100)
          }, '[ChatClient]: Processing event');

          try {
            // Try to extract event type and data
            const lines = event.split('\n');
            let eventType = '';
            let dataContent = '';

            // Extract event type and data
            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventType = line.replace('event:', '').trim();
              } else if (line.startsWith('data:')) {
                dataContent = line.replace('data:', '').trim();
              }
            }

            // Found a valid event with data
            if (dataContent) {
              getLogger().info({
                eventType,
                dataContentLength: dataContent.length,
                dataPreview: dataContent.substring(0, 100)
              }, '[ChatClient]: Found data in event');

              // Try to parse as JSON first
              try {
                const data = JSON.parse(dataContent);

                // Handle known event types
                if (eventType === 'text' && data.text) {
                  getLogger().info({ textLength: data.text.length }, '[ChatClient]: Extracted text from JSON');
                  generatedText = data.text;
                  foundText = true;
                } else if (eventType === 'sources' && Array.isArray(data)) {
                  getLogger().info({ sourcesCount: data.length }, '[ChatClient]: Found sources');
                  sources.push(...data);
                } else if (eventType === 'final' && data.executionTimeMs) {
                  getLogger().info({ executionTimeMs: data.executionTimeMs }, '[ChatClient]: Found execution time');
                  executionTimeMs = data.executionTimeMs;
                }
              } catch (e) {
                // Not JSON, try using raw data
                getLogger().info({ error: e }, '[ChatClient]: Failed to parse as JSON, using raw data');

                // If this is a text event, use the raw data
                if (eventType === 'text' && !foundText) {
                  getLogger().info({ dataLength: dataContent.length }, '[ChatClient]: Using raw data as text');
                  generatedText = dataContent;
                  foundText = true;
                }
              }
            }
          } catch (e) {
            getLogger().warn({ error: e }, '[ChatClient]: Error processing event');
          }
        }

        // If we still don't have text, try alternative approaches
        if (!generatedText && buffer.length > 0) {
          getLogger().info('[ChatClient]: No text found in events, trying alternative extraction');

          // Approach 1: Look for a large text block
          const cleanBuffer = buffer.replace(/event:.*?\n/g, '')
            .replace(/data:/g, '')
            .trim();

          if (cleanBuffer.length > 100) { // Arbitrary threshold for "real" content
            getLogger().info({
              cleanLength: cleanBuffer.length,
              cleanPreview: cleanBuffer.substring(0, 200)
            }, '[ChatClient]: Extracted clean text');
            generatedText = cleanBuffer;
          } else {
            // Approach 2: Just use the raw concatenated chunks
            const allContent = rawChunks.join('');
            if (allContent.length > 100) {
              getLogger().info({
                allContentLength: allContent.length
              }, '[ChatClient]: Using concatenated chunks');
              generatedText = allContent;
            }
          }
        }
      } catch (streamError) {
        getLogger().error({ error: streamError }, '[ChatClient]: Error processing stream');
        throw streamError;
      }

      // Log the final extracted text
      getLogger().info({
        extractedTextLength: generatedText?.length || 0,
        textPreview: generatedText ? generatedText.substring(0, 100) : ''
      }, '[ChatClient]: Final extracted text');

      // Create the response object with the extracted text
      const result: ChatResponse = {
        response: generatedText || '',  // Ensure we never return undefined
        sources: sources.length > 0 ? sources : undefined,
        metadata: {
          executionTimeMs: executionTimeMs || Math.round(performance.now() - startTime),
          nodeTimings: {},
          tokenCounts: {},
        },
      };

      // Log the response
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
  }

  /**
   * Stream a chat response
   * @param request Chat orchestrator request
   * @returns Promise resolving to a streaming response
   */
  async streamResponse(request: ChatRequest): Promise<Response> {
    const startTime = performance.now();

    try {
      // Validate request
      const validatedRequest = chatRequestSchema.parse(request);

      // Call the chat orchestrator directly via RPC
      const response = await this.binding.generateChatResponse(validatedRequest);

      // Log the response
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

      getLogger().info({
        status: response.status,
        statusText: response.statusText,
        headerKeys: headerKeys,
        isBodyUsed: response.bodyUsed,
        response,
      }, '[ChatClient]: Non-streaming chat response received');

      if (!response.ok) {
        throw new Error(`Failed to generate chat message: ${response.status} ${response.statusText}`);
      }

      // Clone the response before parsing to enable safer debugging
      const responseClone = response.clone();

      try {
        // Parse the JSON response using the defined type
        const responseData = await response.json() as ChatServerResponse;
        getLogger().info({
          responseDataKeys: Object.keys(responseData),
          hasGeneratedText: !!responseData.generatedText,
          generatedTextLength: responseData.generatedText?.length || 0
        }, '[ChatClient]: Successfully parsed response JSON');

        // Create the response object using standardized types
        const result: ChatResponse = {
          response: responseData.generatedText || '',
          sources: responseData.sources,
          metadata: {
            executionTimeMs: responseData.metadata?.executionTimeMs || Math.round(performance.now() - startTime),
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
          getLogger().error({ rawText, rawTextLength: rawText.length }, '[ChatClient]: Raw response text');

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
        const errorMessage = parseError instanceof Error
          ? parseError.message
          : 'Unknown parsing error';

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
   * Resume a chat session
   * @param runId Run ID of the chat session to resume
   * @param newMessage Optional new message to add to the conversation
   * @returns Promise resolving to a streaming response
   */
  async resumeChatSession(request: ResumeChatRequest): Promise<Response> {
    const startTime = performance.now();
    const { runId, newMessage } = request;

    try {
      // Call the chat orchestrator directly via RPC
      const response = await this.binding.resumeChatSession({
        runId,
        newMessage,
      });

      // Log the response
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
export function createChatClient(
  binding: ChatBinding,
  metricsPrefix?: string,
): ChatClient {
  return new ChatClient(binding, metricsPrefix);
}

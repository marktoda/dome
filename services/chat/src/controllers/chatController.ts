import { getLogger, logError, metrics, withLogger } from '@dome/logging';
import { z } from 'zod';
import { Services } from '../services';
import { buildChatGraph } from '../graph';
import { secureMessages, secureOutput } from '../utils/securePromptHandler';
import { validateInitialState } from '../utils/inputValidator';
import { transformToSSE } from '../utils/sseTransformer';
import {
  ChatRequest,
  chatRequestSchema,
  ResumeChatRequest,
  resumeChatRequestSchema,
  AgentState
} from '../types';

/**
 * Chat Controller
 *
 * Handles chat-related operations including generating responses,
 * resuming sessions, and managing chat state.
 */
export class ChatController {
  private logger = getLogger().child({ component: 'ChatController' });

  /**
   * Create a new ChatController
   * @param env Environment bindings
   * @param services Service container
   */
  constructor(private readonly env: Env, private readonly services: Services) { }

  /**
   * Generate a chat response with streaming
   * @param request Chat request
   * @returns Streaming response
   */
  async generateChatResponse(request: ChatRequest): Promise<Response> {
    const startTime = performance.now();

    return withLogger(
      {
        service: 'chat-orchestrator',
        operation: 'generateChatResponse',
        userId: request.userId,
        runId: request.runId,
      },
      async () => {
        try {
          // Log minimal request info instead of the full request
          this.logger.debug(
            {
              userId: request.userId,
              messageCount: request.messages?.length || 0,
              hasOptions: !!request.options,
              stream: !!request.stream,
            },
            'Received chat request'
          );

          // Validate request
          const validatedRequest = chatRequestSchema.parse(request);

          // Log minimal validation info
          this.logger.debug(
            {
              userId: validatedRequest.userId,
              messageCount: validatedRequest.messages?.length || 0,
            },
            'Validated chat request'
          );

          // Validate the request as the initial state
          const validatedState = validateInitialState(validatedRequest);

          // Initialize data retention manager
          await this.services.dataRetention.initialize();

          // Register this chat session for retention
          const runId = validatedRequest.runId || crypto.randomUUID();
          const userId = validatedState.userId;
          await this.services.dataRetention.registerDataRecord(runId, userId, 'chatHistory');

          // Apply security to messages
          validatedState.messages = secureMessages(validatedState.messages);

          // Create a state object with a consistent structure
          const state = {
            userId: validatedState.userId,
            messages: validatedState.messages,
            options: validatedState.options,
            tasks: validatedState.tasks || {},
            docs: validatedState.docs || [],
            generatedText: validatedState.generatedText || '',
            metadata: {
              ...validatedState.metadata,
              startTime: performance.now(),
              runId,
            },
          };

          // Process the chat using the common handler
          const response = await this.processChatRequest(state, runId, startTime, 'generated');

          // Return the response
          return response;
        } catch (error) {
          // Log error
          logError(error, 'Error generating chat response', {
            userId: request.userId,
            runId: request.runId,
            executionTimeMs: Math.round(performance.now() - startTime),
          });

          // Track error metrics
          metrics.increment('chat_orchestrator.chat.errors', 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
          });

          // Return error stream
          return new Response(this.createErrorStream(error), {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          });
        }
      }
    );
  }

  /**
   * Resume a chat session
   * @param request Resume chat request
   * @returns Streaming response
   */
  async resumeChatSession(request: ResumeChatRequest): Promise<Response> {
    const startTime = performance.now();

    return withLogger(
      {
        service: 'chat-orchestrator',
        operation: 'resumeChatSession',
        runId: request.runId,
      },
      async () => {
        try {
          // Validate request
          const validatedRequest = resumeChatRequestSchema.parse(request);

          // Validate new message if provided
          let newMessage = undefined;
          if (validatedRequest.newMessage) {
            newMessage = secureMessages([validatedRequest.newMessage])[0];
          }

          // Create a new state object with the message
          const state = {
            userId: validatedRequest.runId, // Use runId as userId for now
            messages: newMessage ? [newMessage] : [],
            options: {
              enhanceWithContext: true,
              maxContextItems: 5,
              includeSourceInfo: true,
              maxTokens: 1000,
            },
            tasks: {},
            docs: [],
            generatedText: '',
            metadata: {
              startTime: performance.now(),
              nodeTimings: {},
              tokenCounts: {},
              errors: [],
              runId: validatedRequest.runId,
            },
          };

          // Process the chat using the common handler
          const response = await this.processChatRequest(state, validatedRequest.runId, startTime, 'resumed');

          // Return the response
          return response;
        } catch (error) {
          // Log error
          logError(error, 'Error resuming chat session', {
            runId: request.runId,
            executionTimeMs: Math.round(performance.now() - startTime),
          });

          // Track error metrics
          metrics.increment('chat_orchestrator.chat.errors', 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
            operation: 'resume',
          });

          // Return error stream
          return new Response(this.createErrorStream(error), {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          });
        }
      }
    );
  }

  /**
   * Common method to process chat requests for both new chats and resuming sessions
   * @param state The initial state for the graph
   * @param runId The run ID for the chat session
   * @param startTime The time when processing started
   * @param metricsType The type of metrics to track ('generated' or 'resumed')
   * @returns A streaming response
   */
  private async processChatRequest(
    state: AgentState,
    runId: string,
    startTime: number,
    metricsType: 'generated' | 'resumed'
  ): Promise<Response> {
    // Initialize checkpointer
    await this.services.checkpointer.initialize();

    // Build the chat graph
    const graph = await buildChatGraph(
      this.env,
      this.services.checkpointer,
      this.services.toolRegistry
    );

    // Generate a unique thread_id for this request to prevent checkpoint conflicts
    const thread_id = crypto.randomUUID();

    this.logger.info(
      { thread_id, runId },
      metricsType === 'generated'
        ? 'Starting graph stream with fresh thread_id'
        : 'Resuming chat with fresh thread_id'
    );

    // Use "messages" mode to get LLM tokens as they're generated
    const result = await graph.stream(state, {
      configurable: {
        thread_id: thread_id,
        runId: runId,
      },
      streamMode: "messages", // Optimized for LLM token streaming
    });

    // Transform to SSE stream
    const transformedStream = transformToSSE(result, startTime);

    // Track metrics
    metrics.increment(`chat_orchestrator.chat.${metricsType}`, 1);

    // Return the stream
    return new Response(transformedStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Create error response stream
   * @param error Error object
   * @returns ReadableStream with error event
   */
  private createErrorStream(error: unknown): ReadableStream {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const encoder = new TextEncoder();

    return new ReadableStream({
      start(controller) {
        const errorEvent = `event: error\ndata: ${JSON.stringify({
          message: errorMessage,
        })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
        controller.close();
      },
    });
  }
}

/**
 * Create a new ChatController
 * @param env Environment bindings
 * @param services Service container
 * @returns ChatController instance
 */
export function createChatController(env: Env, services: Services): ChatController {
  return new ChatController(env, services);
}

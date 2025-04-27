import { getLogger, logError, metrics, withLogger } from '@dome/logging';
import { z } from 'zod';
import { Services } from '../services';
import { buildChatGraph } from '../graph';
import { secureMessages, secureOutput } from '../utils/securePromptHandler';
import { validateInitialState } from '../utils/inputValidator';
import { transformToSSE } from '../utils/sseTransformer';
import { transformToWebSocket, sendErrorMessage } from '../utils/wsTransformer';
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
   * Generate a non-streaming chat message
   * @param request Chat request
   * @returns Complete response with aggregated output
   */
  async generateChatMessage(request: ChatRequest): Promise<Response> {
    const startTime = performance.now();

    return withLogger(
      {
        service: 'chat-orchestrator',
        operation: 'generateChatMessage',
        userId: request.userId,
        runId: request.runId,
      },
      async () => {
        try {
          // Log minimal request info
          this.logger.debug(
            {
              userId: request.userId,
              messageCount: request.messages?.length || 0,
              hasOptions: !!request.options,
            },
            'Received non-streaming chat request'
          );

          // Validate request
          const validatedRequest = chatRequestSchema.parse(request);

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

          // Process the chat using the common non-streaming handler
          return await this.processChatMessageNonStreaming(state, runId, startTime);
        } catch (error) {
          // Log error
          logError(error, 'Error generating chat message', {
            userId: request.userId,
            runId: request.runId,
            executionTimeMs: Math.round(performance.now() - startTime),
          });

          // Track error metrics
          metrics.increment('chat_orchestrator.chat.errors', 1, {
            errorType: error instanceof Error ? error.constructor.name : 'unknown',
            streaming: 'false',
          });

          // Return error as JSON
          return new Response(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
            {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );
        }
      }
    );
  }

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

    // We're returning a standard response (not a WebSocket upgrade)
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
   * Process chat request and return a complete non-streaming response
   * @param state The initial state for the graph
   * @param runId The run ID for the chat session
   * @param startTime The time when processing started
   * @returns A complete JSON response with the chat result
   */
  private async processChatMessageNonStreaming(
    state: AgentState,
    runId: string,
    startTime: number
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
      'Starting graph execution for non-streaming response'
    );

    // Use "messages" mode to get LLM tokens as they're generated
    const result = await graph.invoke(state, {
      configurable: {
        thread_id: thread_id,
        runId: runId,
      },
    });

    // Track metrics
    metrics.increment('chat_orchestrator.chat.generated', 1, {
      streaming: 'false',
    });

    // Return the complete response
    return new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Aggregate stream results into a single response object
   * @param stream The graph output stream
   * @param startTime The processing start time
   * @returns Complete aggregated response
   */
  private async aggregateStreamResults(stream: any, startTime: number): Promise<Record<string, any>> {
    this.logger.info('Aggregating stream results');

    // Store accumulated content
    let accumulatedText = '';
    let sources: any[] = [];
    let executionTimeMs = 0;
    let stateCount = 0;

    try {
      // Process each event from the LangGraph stream
      for await (const event of stream) {
        stateCount++;

        this.logger.debug({
          eventNumber: stateCount,
          eventType: event.event,
          eventName: event.name,
        }, 'Processing event for aggregation');

        // Handle different event types
        if (event.event === 'on_chat_model_stream') {
          // Extract the token chunk
          const chunk = event.data?.chunk;
          if (chunk && chunk.content) {
            // Add this chunk to our accumulated text
            accumulatedText += chunk.content;
          }
        } else if (event.event === 'on_chain_stream' && event.metadata?.langgraph_node) {
          // If this is a state update that includes docs, extract them
          if (event.data?.state?.docs && Array.isArray(event.data.state.docs) && event.data.state.docs.length > 0) {
            const docs = event.data.state.docs;

            // Extract source metadata
            sources = docs.map((doc: any) => ({
              id: doc.id,
              title: doc.title,
              source: doc.metadata.source,
              url: doc.metadata.url,
              relevanceScore: doc.metadata.relevanceScore,
            }));
          }
        } else if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
          // This is the final event
          executionTimeMs = performance.now() - startTime;
        }
      }

      this.logger.info({
        eventCount: stateCount,
        finalTextLength: accumulatedText.length,
        sourcesCount: sources.length,
        executionTimeMs: Math.round(executionTimeMs),
      }, 'Stream aggregation complete');

      // Create the final result object
      return {
        text: accumulatedText,
        sources: sources,
        metadata: {
          executionTimeMs: Math.round(executionTimeMs),
        }
      };
    } catch (error) {
      this.logger.error({
        error,
      }, 'Error aggregating stream results');

      // Return partial results if we have them
      return {
        text: accumulatedText || 'An error occurred during processing.',
        sources: sources,
        metadata: {
          executionTimeMs: Math.round(performance.now() - startTime),
          error: error instanceof Error ? error.message : String(error),
        }
      };
    }
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
/**
 * Handle WebSocket connection for chat streams
 * @param webSocket WebSocket connection
 * @param state Initial agent state
 * @param runId Chat run ID
 * @param metricsType Metrics type ('generated' or 'resumed')
 * @returns Promise that resolves when chat processing is complete
 */
/**
 * Process a chat request via WebSocket
 * Updated to work with Hono's WebSocket helper
 * @param env Environment bindings
 * @param services Service container
 * @param webSocket WebSocket connection
 * @param state Initial agent state
 * @param runId Chat run ID
 * @param metricsType Metrics type ('generated' or 'resumed')
 * @returns Promise that resolves when chat processing is complete
 */
// Original handleWebSocketChat functionality moved to handleWebSocketChatProcessing below

/**
 * Create a new ChatController
 * @param env Environment bindings
 * @param services Service container
 * @returns ChatController instance
 */
export function createChatController(env: Env, services: Services): ChatController {
  return new ChatController(env, services);
}

/**
 * Handle a WebSocket connection for chat
 * @param env Environment bindings
 * @param services Service container
 * @param webSocket WebSocket connection
 * @param request Initial request data
 */
/**
 * Process WebSocket message
 * Takes a message and processes it, dispatching to the appropriate handler
 * @param env Environment bindings
 * @param services Service container
 * @param webSocket WebSocket connection
 * @param message Parsed message data
 */
export function handleWebSocketChat(
  env: Env,
  services: Services,
  webSocket: WebSocket,
  message: any
): void {
  const logger = getLogger().child({ component: 'WebSocketConnection' });

  logger.info({
    type: message.type,
    userId: message.userId,
    runId: message.runId
  }, 'Processing WebSocket message');

  // Handle different request types
  if (message.type === 'new_chat') {
    try {
      // Validate request
      const validatedRequest = chatRequestSchema.parse(message);

      // Validate the request as the initial state
      const validatedState = validateInitialState(validatedRequest);

      // Initialize data retention manager (don't await, do in background)
      services.dataRetention.initialize().then(() => {
        // Register this chat session for retention (also in background)
        const runId = validatedRequest.runId || crypto.randomUUID();
        const userId = validatedState.userId;
        services.dataRetention.registerDataRecord(runId, userId, 'chatHistory');
      });

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
          runId: validatedRequest.runId || crypto.randomUUID(),
        },
      };

      // Process the chat using WebSocket
      handleWebSocketChatProcessing(
        env,
        services,
        webSocket,
        state,
        state.metadata.runId as string,
        'generated'
      );
    } catch (error) {
      logger.error({
        error,
        type: 'new_chat',
        userId: message.userId
      }, 'Error handling new chat WebSocket request');

      // Send error to client
      sendErrorMessage(webSocket, error);
    }
  } else if (message.type === 'resume_chat') {
    try {
      // Validate request
      const validatedRequest = resumeChatRequestSchema.parse(message);

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

      // Process the chat using WebSocket
      handleWebSocketChatProcessing(
        env,
        services,
        webSocket,
        state,
        validatedRequest.runId,
        'resumed'
      );
    } catch (error) {
      logger.error({
        error,
        type: 'resume_chat',
        runId: message.runId
      }, 'Error handling resume chat WebSocket request');

      // Send error to client
      sendErrorMessage(webSocket, error);
    }
  } else {
    // Unknown request type
    const error = new Error(`Unknown WebSocket request type: ${message.type}`);
    logger.error({
      error,
      requestType: message.type
    }, 'Invalid WebSocket request type');

    // Send error to client
    sendErrorMessage(webSocket, error);
  }
}

/**
 * Process a chat request via WebSocket - internal helper
 * Handles the actual streaming of data through the WebSocket
 * @param env Environment bindings
 * @param services Service container
 * @param webSocket WebSocket connection
 * @param state Initial agent state
 * @param runId Chat run ID
 * @param metricsType Metrics type ('generated' or 'resumed')
 * @returns Promise that resolves when chat processing is complete
 */
async function handleWebSocketChatProcessing(
  env: Env,
  services: Services,
  webSocket: WebSocket,
  state: AgentState,
  runId: string,
  metricsType: 'generated' | 'resumed'
): Promise<void> {
  const logger = getLogger().child({ component: 'WebSocketHandler' });
  const startTime = performance.now();

  try {
    // Initialize checkpointer
    await services.checkpointer.initialize();

    // Build the chat graph
    const graph = await buildChatGraph(
      env,
      services.checkpointer,
      services.toolRegistry
    );

    // Generate a unique thread_id for this request to prevent checkpoint conflicts
    const thread_id = crypto.randomUUID();

    logger.info(
      { thread_id, runId },
      metricsType === 'generated'
        ? 'Starting graph stream with WebSocket and fresh thread_id'
        : 'Resuming chat with WebSocket and fresh thread_id'
    );

    // Use "messages" mode to get LLM tokens as they're generated
    const result = await graph.stream(state, {
      configurable: {
        thread_id: thread_id,
        runId: runId,
      },
      streamMode: "messages", // Optimized for LLM token streaming
    });

    // Process the stream and send messages through WebSocket
    await transformToWebSocket(result, startTime, webSocket);

    // Track metrics
    metrics.increment(`chat_orchestrator.chat.${metricsType}`, 1, {
      transport: 'websocket'
    });

    logger.info({
      runId,
      executionTimeMs: Math.round(performance.now() - startTime)
    }, 'WebSocket chat streaming completed');
  } catch (error) {
    // Log error
    logError(error, 'Error processing WebSocket chat', {
      runId,
      executionTimeMs: Math.round(performance.now() - startTime),
    });

    // Track error metrics
    metrics.increment('chat_orchestrator.chat.errors', 1, {
      errorType: error instanceof Error ? error.constructor.name : 'unknown',
      transport: 'websocket'
    });

    // Send error message through WebSocket
    sendErrorMessage(webSocket, error);
  }
}

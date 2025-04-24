import { Bindings } from '../types';
import { SearchService, SearchResult } from './searchService';
import { ServiceError } from '@dome/common';
import { getLogger } from '@dome/logging';

/**
 * Chat message interface
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Chat options interface
 */
export interface ChatOptions {
  messages: ChatMessage[];
  userId: string;
  enhanceWithContext?: boolean;
  maxContextItems?: number;
  includeSourceInfo?: boolean;
  suggestAddCommand?: boolean;
}

/**
 * Service for chat operations
 */
export class ChatService {
  // Model to use for chat
  private readonly MODEL_NAME = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

  // Maximum context window size for the model (in tokens)
  private readonly MAX_CONTEXT_WINDOW = 24000;
  // Approximate tokens per character (used for estimation)
  private readonly TOKENS_PER_CHAR = 0.25;
  // Reserve tokens for the model's response
  private readonly RESPONSE_TOKEN_RESERVE = 2000;
  // Maximum system prompt size in tokens
  private readonly MAX_SYSTEM_PROMPT_TOKENS = this.MAX_CONTEXT_WINDOW - this.RESPONSE_TOKEN_RESERVE;

  private logger;
  private searchService: SearchService;

  constructor(searchService: SearchService) {
    this.logger = getLogger();
    this.searchService = searchService;
  }

  /**
   * Estimate the number of tokens in a text
   * @param text The text to estimate tokens for
   * @returns Estimated token count
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length * this.TOKENS_PER_CHAR);
  }

  /**
   * Truncate text to fit within a token limit
   * @param text Text to truncate
   * @param maxTokens Maximum tokens allowed
   * @returns Truncated text
   */
  private truncateToTokenLimit(text: string, maxTokens: number): string {
    const estimatedTokens = this.estimateTokens(text);
    if (estimatedTokens <= maxTokens) {
      return text;
    }

    // Simple truncation based on character count
    const maxChars = Math.floor(maxTokens / this.TOKENS_PER_CHAR);
    return text.substring(0, maxChars) + '... [truncated due to length]';
  }

  async getSystemPrompt(env: Bindings, options: ChatOptions): Promise<ChatMessage> {
    const {
      messages,
      userId,
      enhanceWithContext = true,
      maxContextItems = 10, // Increased from 5 to 10 since we have a larger context window
      includeSourceInfo = true,
    } = options;

    // Get the last user message
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');

    if (!lastUserMessage) {
      throw new ServiceError('At least one user message is required');
    }

    getLogger().info({ lastMessage: lastUserMessage }, 'Retrieving context for system prompt');
    // Retrieve relevant context if enhanceWithContext is true
    let formattedContext = '';
    if (enhanceWithContext) {
      const context = await this.retrieveContext(
        env,
        userId,
        lastUserMessage.content,
        maxContextItems,
      );

      // Format context for inclusion in the prompt
      formattedContext = this.formatContextForPrompt(context, includeSourceInfo);

      // Log context size information
      const contextTokens = this.estimateTokens(formattedContext);
      getLogger().info(
        {
          contextLength: formattedContext.length,
          estimatedTokens: contextTokens,
          maxAllowed: this.MAX_SYSTEM_PROMPT_TOKENS,
        },
        'Got context for system prompt',
      );

      // Limit context size if it's too large
      if (contextTokens > this.MAX_SYSTEM_PROMPT_TOKENS) {
        getLogger().warn(
          {
            originalLength: formattedContext.length,
            originalTokens: contextTokens,
          },
          'Context is too large, truncating',
        );
        formattedContext = this.truncateToTokenLimit(
          formattedContext,
          this.MAX_SYSTEM_PROMPT_TOKENS,
        );
        getLogger().info(
          {
            newLength: formattedContext.length,
            newTokens: this.estimateTokens(formattedContext),
          },
          'Context truncated',
        );
      }
    }

    // Create a system message with context if available
    const systemPrompt = this.createSystemPrompt(formattedContext);

    // Log system prompt size information
    getLogger().info(
      {
        systemPromptLength: systemPrompt.length,
        estimatedTokens: this.estimateTokens(systemPrompt),
      },
      'Created system prompt',
    );

    return {
      role: 'system',
      content: systemPrompt,
    };
  }

  /**
   * Generate a chat response
   * @param env Environment bindings
   * @param options Chat options
   * @returns Promise<string>
   */
  async generateResponse(env: Bindings, options: ChatOptions): Promise<string> {
    try {
      const { messages } = options;

      const systemMessage = await this.getSystemPrompt(env, options);
      getLogger().info({ systemMessage }, 'Got system prompt');

      // Combine system message with user messages
      const promptMessages = [systemMessage, ...messages];

      // Check if AI binding is available
      if (!env.AI) {
        // In test environment, return a mock response
        if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
          return 'This is a mock response for testing purposes.';
        }

        getLogger().warn('Workers AI binding is not available, using fallback response');
        return "I'm sorry, but I'm unable to process your request at the moment due to a technical issue. The AI service is currently unavailable. Please try again later.";
      }

      try {
        // Call Workers AI with timeout and error handling
        getLogger().info({ model: this.MODEL_NAME }, 'Calling Workers AI');
        const response = await Promise.race([
          env.AI.run(this.MODEL_NAME, {
            messages: promptMessages,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('AI request timed out after 15 seconds')), 15000),
          ),
        ]);

        // Check if we have a valid response
        if (!response || !response.response) {
          getLogger().warn('AI returned an invalid or empty response, using fallback');
          return "I'm sorry, but I couldn't generate a proper response at this time. Please try again with a different question.";
        }

        getLogger().info({ responseLength: response.response.length }, 'Got valid AI response');
        return response.response;
      } catch (aiError) {
        // Handle specific AI service errors
        getLogger().error({ err: aiError }, 'Error from AI service');

        // Provide a fallback response instead of throwing
        return "I'm sorry, but I encountered an issue while processing your request. The AI service is experiencing difficulties. Please try again later.";
      }
    } catch (error) {
      getLogger().error({ err: error }, 'Error generating chat response');

      // Instead of throwing, return a fallback response
      return "I apologize, but I'm experiencing technical difficulties. Please try again later or contact support if the issue persists.";
    }
  }

  /**
   * Stream a chat response
   * @param env Environment bindings
   * @param options Chat options
   * @returns Promise<ReadableStream>
   */
  async streamResponse(env: Bindings, options: ChatOptions): Promise<ReadableStream> {
    try {
      const { messages } = options;
      const systemMessage = await this.getSystemPrompt(env, options);

      // Combine system message with user messages
      const promptMessages = [systemMessage, ...messages];

      // Create a TransformStream for streaming the response
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      // Start generating the response in the background
      this.generateStreamingResponse(env, promptMessages, writer);

      return readable;
    } catch (error: unknown) {
      // Enhanced error logging with more context
      getLogger().error(
        {
          err: error,
          errorType: typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : 'No stack trace',
          errorName: error instanceof Error ? error.name : 'Unknown',
          // Include context about the request
          userId: options.userId,
          messageCount: options.messages.length,
          enhanceWithContext: options.enhanceWithContext,
          // Try to capture all error properties
          errorJSON: (() => {
            try {
              return JSON.stringify(
                error,
                Object.getOwnPropertyNames(error instanceof Error ? error : {}),
              );
            } catch (e) {
              return `Failed to stringify error: ${e instanceof Error ? e.message : String(e)}`;
            }
          })(),
          // Include all enumerable properties
          errorProps: (() => {
            try {
              if (typeof error === 'object' && error !== null) {
                return Object.keys(error);
              }
              return [];
            } catch (e) {
              return [`Error getting properties: ${String(e)}`];
            }
          })(),
        },
        'Error setting up streaming chat response',
      );

      // Create a stream with an error message instead of throwing
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      writer
        .write(
          new TextEncoder().encode(
            "I apologize, but I'm experiencing technical difficulties. Please try again later or contact support if the issue persists.",
          ),
        )
        .then(() => writer.close());

      return readable;
    }
  }

  /**
   * Generate a streaming response
   * @param env Environment bindings
   * @param promptMessages Array of messages to send to the AI
   * @param writer Writer to write the response to
   */
  private generateStreamingResponse(
    env: Bindings,
    promptMessages: ChatMessage[],
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): void {
    // Execute in an async IIFE to allow for proper error handling
    (async () => {
      try {
        // Check if AI binding is available
        if (!env.AI) {
          // In test environment, create a mock stream
          if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
            const mockResponses = [
              'This ',
              'is ',
              'a ',
              'mock ',
              'streaming ',
              'response ',
              'for ',
              'testing ',
              'purposes.',
            ];
            for (const text of mockResponses) {
              await writer.write(new TextEncoder().encode(text));
              // Add a small delay to simulate streaming
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await writer.close();
            return;
          }

          // Provide a fallback response instead of throwing
          getLogger().warn('Workers AI binding is not available, using fallback response');
          const fallbackResponse =
            "I'm sorry, but I'm unable to process your request at the moment due to a technical issue. The AI service is currently unavailable. Please try again later.";
          await writer.write(new TextEncoder().encode(fallbackResponse));
          await writer.close();
          return;
        }

        // Set up a timeout for the AI request
        const timeoutId = setTimeout(async () => {
          getLogger().warn('AI streaming request timed out');
          await writer.write(
            new TextEncoder().encode(
              "I'm sorry, but the request is taking too long to process. Please try again later.",
            ),
          );
          await writer.close();
        }, 15000); // 15 second timeout

        try {
          // Call Workers AI with streaming
          getLogger().info(
            {
              model: this.MODEL_NAME,
              messageCount: promptMessages.length,
              systemPromptLength: promptMessages[0]?.content?.length || 0,
              lastUserMessageLength:
                promptMessages[promptMessages.length - 1]?.content?.length || 0,
            },
            'Calling Workers AI with streaming',
          );

          // Log the request details
          getLogger().debug(
            {
              model: this.MODEL_NAME,
              stream: true,
              messagesPreview: promptMessages.map(m => ({
                role: m.role,
                contentLength: m.content.length,
                contentPreview: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
              })),
            },
            'AI streaming request details',
          );

          const response = await env.AI.run(this.MODEL_NAME, {
            messages: promptMessages,
            stream: true,
          });

          // Clear the timeout since we got a response
          clearTimeout(timeoutId);
          getLogger().info('Received streaming response from AI service');

          // Stream each chunk as it becomes available
          let chunkCount = 0;
          let totalCharsStreamed = 0;

          try {
            for await (const chunk of response) {
              chunkCount++;
              const text = chunk.response;

              if (text) {
                totalCharsStreamed += text.length;
                if (chunkCount % 10 === 0 || chunkCount === 1) {
                  getLogger().debug(
                    {
                      chunkNumber: chunkCount,
                      chunkSize: text.length,
                      totalStreamed: totalCharsStreamed,
                      chunkPreview: text.substring(0, 20) + (text.length > 20 ? '...' : ''),
                    },
                    'Streaming chunk received',
                  );
                }
                await writer.write(new TextEncoder().encode(text));
              } else {
                getLogger().warn(
                  { chunkNumber: chunkCount },
                  'Received empty chunk from AI service',
                );
              }
            }

            getLogger().info(
              {
                totalChunks: chunkCount,
                totalCharsStreamed: totalCharsStreamed,
              },
              'Completed streaming response',
            );

            // Close the stream
            await writer.close();
          } catch (streamingError: unknown) {
            getLogger().error(
              {
                err: streamingError,
                errorName: streamingError instanceof Error ? streamingError.name : 'Unknown',
                errorMessage:
                  streamingError instanceof Error ? streamingError.message : String(streamingError),
                errorStack:
                  streamingError instanceof Error ? streamingError.stack : 'No stack trace',
                chunkCount: chunkCount,
                totalCharsStreamed: totalCharsStreamed,
              },
              'Error while processing streaming chunks',
            );
            throw streamingError; // Re-throw to be caught by the outer catch
          }
        } catch (aiError: unknown) {
          // Clear the timeout
          clearTimeout(timeoutId);

          // Log detailed information about the error context
          getLogger().error(
            {
              // Request context
              model: this.MODEL_NAME,
              messageCount: promptMessages.length,
              systemPromptLength: promptMessages[0]?.content?.length || 0,
              lastUserMessageLength:
                promptMessages[promptMessages.length - 1]?.content?.length || 0,
              requestHasStream: true,

              // Basic error info
              err: aiError,
              errorType: typeof aiError,
              errorName: aiError instanceof Error ? aiError.name : 'Unknown',
              errorMessage: aiError instanceof Error ? aiError.message : String(aiError),
              errorStack: aiError instanceof Error ? aiError.stack : 'No stack trace',

              // Attempt to stringify the entire error object with all properties
              errorJSON: (() => {
                try {
                  return JSON.stringify(
                    aiError,
                    Object.getOwnPropertyNames(aiError instanceof Error ? aiError : {}),
                  );
                } catch (e) {
                  return `Failed to stringify error: ${e instanceof Error ? e.message : String(e)}`;
                }
              })(),

              // Include all enumerable properties
              errorProps: (() => {
                try {
                  if (typeof aiError === 'object' && aiError !== null) {
                    return Object.keys(aiError);
                  }
                  return [];
                } catch (e) {
                  return [`Error getting properties: ${String(e)}`];
                }
              })(),
            },
            'Error from AI streaming service',
          );

          // Try to extract more information if it's a Response object
          if (aiError instanceof Response) {
            try {
              // Log response metadata
              getLogger().error(
                {
                  status: aiError.status,
                  statusText: aiError.statusText,
                  headers: JSON.stringify([...aiError.headers.entries()]),
                  responseType: aiError.type,
                  responseUrl: aiError.url,
                  responseRedirected: aiError.redirected,
                  responseOk: aiError.ok,
                },
                'AI streaming error response details',
              );

              // Try to get the response body
              const errorBody = await aiError.text();
              getLogger().error(
                {
                  errorBody,
                  errorBodyLength: errorBody.length,
                  errorBodyPreview:
                    errorBody.substring(0, 500) + (errorBody.length > 500 ? '...' : ''),
                },
                'AI streaming error response body',
              );

              // Try to parse as JSON if it looks like JSON
              if (errorBody.trim().startsWith('{') || errorBody.trim().startsWith('[')) {
                try {
                  const jsonData = JSON.parse(errorBody);
                  getLogger().error({ jsonData }, 'AI streaming error response JSON');
                } catch (jsonError) {
                  getLogger().error(
                    { err: jsonError, bodyStart: errorBody.substring(0, 100) },
                    'Failed to parse error body as JSON',
                  );
                }
              }
            } catch (responseError) {
              getLogger().error(
                {
                  err: responseError,
                  errorType: typeof responseError,
                  errorMessage:
                    responseError instanceof Error ? responseError.message : String(responseError),
                  errorStack:
                    responseError instanceof Error ? responseError.stack : 'No stack trace',
                },
                'Failed to extract details from error response',
              );
            }
          } else if (typeof aiError === 'object' && aiError !== null && 'status' in aiError) {
            // Handle error objects with status property (like fetch Response)
            const errorObj = aiError as {
              status?: number;
              statusText?: string;
              headers?: any;
              text?: () => Promise<string>;
              body?: any;
              type?: string;
              url?: string;
              ok?: boolean;
            };

            try {
              // Log all available properties
              getLogger().error(
                {
                  status: errorObj.status,
                  statusText: errorObj.statusText,
                  headers: errorObj.headers ? JSON.stringify(errorObj.headers) : 'No headers',
                  hasTextMethod: typeof errorObj.text === 'function',
                  hasBodyProperty: 'body' in errorObj,
                  responseType: errorObj.type,
                  responseUrl: errorObj.url,
                  responseOk: errorObj.ok,
                  allProperties: Object.keys(errorObj),
                },
                'AI streaming error object details',
              );

              // Try to get the response body if text method exists
              if (typeof errorObj.text === 'function') {
                const errorBody = await errorObj.text();
                getLogger().error(
                  {
                    errorBody,
                    errorBodyLength: errorBody.length,
                    errorBodyPreview:
                      errorBody.substring(0, 500) + (errorBody.length > 500 ? '...' : ''),
                  },
                  'AI streaming error object body',
                );

                // Try to parse as JSON if it looks like JSON
                if (errorBody.trim().startsWith('{') || errorBody.trim().startsWith('[')) {
                  try {
                    const jsonData = JSON.parse(errorBody);
                    getLogger().error({ jsonData }, 'AI streaming error body JSON');
                  } catch (jsonError) {
                    getLogger().error(
                      { err: jsonError, bodyStart: errorBody.substring(0, 100) },
                      'Failed to parse error body as JSON',
                    );
                  }
                }
              }

              // If there's a body property, try to log it
              if (errorObj.body) {
                getLogger().error(
                  {
                    bodyType: typeof errorObj.body,
                    bodyIsReadable:
                      errorObj.body &&
                      typeof errorObj.body === 'object' &&
                      'readable' in errorObj.body,
                    bodyProperties:
                      typeof errorObj.body === 'object' ? Object.keys(errorObj.body) : [],
                  },
                  'AI streaming error body property',
                );
              }
            } catch (responseError) {
              getLogger().error(
                {
                  err: responseError,
                  errorType: typeof responseError,
                  errorMessage:
                    responseError instanceof Error ? responseError.message : String(responseError),
                  errorStack:
                    responseError instanceof Error ? responseError.stack : 'No stack trace',
                },
                'Failed to extract details from error object',
              );
            }
          }

          await writer.write(
            new TextEncoder().encode(
              "I'm sorry, but I encountered an issue while processing your request. The AI service is experiencing difficulties. Please try again later.",
            ),
          );
          await writer.close();
        }
      } catch (error: unknown) {
        getLogger().error(
          {
            err: error,
            errorType: typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          'Error in stream chat',
        );

        // Provide a user-friendly error message
        const errorMessage =
          "I apologize, but I'm experiencing technical difficulties. Please try again later.";
        await writer.write(new TextEncoder().encode(errorMessage));
        await writer.close();
      }
    })();
  }

  /**
   * Retrieve context for RAG enhancement
   * @param env Environment bindings
   * @param userId User ID
   * @param query Query text
   * @param maxItems Maximum number of context items to retrieve
   * @returns Promise<NoteSearchResult[]>
   */
  private async retrieveContext(
    env: Bindings,
    userId: string,
    query: string,
    maxItems: number,
  ): Promise<SearchResult[]> {
    try {
      // Search for relevant notes
      const searchResults = await this.searchService.search(env, {
        userId,
        query,
        limit: maxItems,
      });

      // Extract just the results array from the paginated response
      // Add null check to handle case when searchResults is undefined or doesn't have results
      return searchResults?.results || [];
    } catch (error) {
      getLogger().error({ err: error, userId, query }, 'Error retrieving context');
      // Return empty context on error
      return [];
    }
  }

  /**
   * Format context for inclusion in the prompt
   * @param context Context from notes
   * @param includeSourceInfo Whether to include source information
   * @returns Formatted context string
   */
  private formatContextForPrompt(context: any[], includeSourceInfo = true): string {
    if (context.length === 0) {
      return '';
    }

    return context
      .map((item, index) => {
        const formattedDate = new Date(item.createdAt).toISOString().split('T')[0];
        const sourceInfo = includeSourceInfo
          ? `\n[Source: Note ID ${item.id}, created ${formattedDate}]`
          : '';

        return `[${index + 1}] ${item.title}\n${item.body}${sourceInfo}`;
      })
      .join('\n\n');
  }

  /**
   * Create a system prompt with context and instructions
   * @param formattedContext Formatted context string
   * @returns System prompt string
   */
  private createSystemPrompt(formattedContext: string): string {
    let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";

    if (formattedContext) {
      prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedContext}\n\n`;
      prompt +=
        'When referencing information from these notes, include the note number in brackets, e.g., [1], to help the user identify the source.\n\n';
    }

    prompt +=
      'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';

    return prompt;
  }
}

// No longer exporting a singleton instance
// The service factory will create and manage instances

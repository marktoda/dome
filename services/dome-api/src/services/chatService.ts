import { Bindings } from '../types';
import { searchService, SearchResult } from './searchService';
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
  private readonly MODEL_NAME = 'llama-3.3-70b-instruct-fp8-fast';

  // Maximum context window size for the model (in tokens)
  private readonly MAX_CONTEXT_WINDOW = 24000;
  // Approximate tokens per character (used for estimation)
  private readonly TOKENS_PER_CHAR = 0.25;
  // Reserve tokens for the model's response
  private readonly RESPONSE_TOKEN_RESERVE = 2000;
  // Maximum system prompt size in tokens
  private readonly MAX_SYSTEM_PROMPT_TOKENS = this.MAX_CONTEXT_WINDOW - this.RESPONSE_TOKEN_RESERVE;

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
            getLogger().info({ model: this.MODEL_NAME }, 'Calling Workers AI with streaming');
            const response = await env.AI.run(this.MODEL_NAME, {
              messages: promptMessages,
              stream: true,
            });

            // Clear the timeout since we got a response
            clearTimeout(timeoutId);

            // Stream each chunk as it becomes available
            for await (const chunk of response) {
              const text = chunk.response;
              if (text) {
                await writer.write(new TextEncoder().encode(text));
              }
            }

            // Close the stream
            await writer.close();
          } catch (aiError) {
            // Clear the timeout
            clearTimeout(timeoutId);

            // Handle AI-specific errors
            getLogger().error({ err: aiError }, 'Error from AI streaming service');
            await writer.write(
              new TextEncoder().encode(
                "I'm sorry, but I encountered an issue while processing your request. The AI service is experiencing difficulties. Please try again later.",
              ),
            );
            await writer.close();
          }
        } catch (error) {
          getLogger().error({ err: error }, 'Error in stream chat');

          // Provide a user-friendly error message
          const errorMessage =
            "I apologize, but I'm experiencing technical difficulties. Please try again later.";
          await writer.write(new TextEncoder().encode(errorMessage));
          await writer.close();
        }
      })();

      return readable;
    } catch (error) {
      getLogger().error({ err: error }, 'Error setting up streaming chat response');

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
      const searchResults = await searchService.search(env, {
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

// Export singleton instance
export const chatService = new ChatService();

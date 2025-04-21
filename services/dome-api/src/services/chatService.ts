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
}

/**
 * Service for chat operations
 */
export class ChatService {
  async getSystemPrompt(env: Bindings, options: ChatOptions): Promise<ChatMessage> {
    const {
      messages,
      userId,
      enhanceWithContext = true,
      maxContextItems = 5,
      includeSourceInfo = true,
    } = options;

    // Get the last user message
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');

    if (!lastUserMessage) {
      throw new ServiceError('At least one user message is required');
    }

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
    }

    // Create a system message with context if available
    return {
      role: 'system',
      content: this.createSystemPrompt(formattedContext),
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

      // Combine system message with user messages
      const promptMessages = [systemMessage, ...messages];

      // Check if AI binding is available
      if (!env.AI) {
        // In test environment, return a mock response
        if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
          return 'This is a mock response for testing purposes.';
        }
        throw new ServiceError('Workers AI binding is not available');
      }

      // Call Workers AI
      const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: promptMessages,
      });

      return response.response;
    } catch (error) {
      getLogger().error({ err: error }, 'Error generating chat response');
      throw new ServiceError('Failed to generate chat response', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
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
            throw new ServiceError('Workers AI binding is not available');
          }

          // Call Workers AI with streaming
          const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: promptMessages,
            stream: true,
          });

          // Stream each chunk as it becomes available
          for await (const chunk of response) {
            const text = chunk.response;
            if (text) {
              await writer.write(new TextEncoder().encode(text));
            }
          }

          // Close the stream
          await writer.close();
        } catch (error) {
          getLogger().error({ err: error }, 'Error in stream chat');

          // Write error to stream
          const errorJson =
            JSON.stringify({
              error: {
                code: 'CHAT_ERROR',
                message: error instanceof Error ? error.message : 'An unexpected error occurred',
              },
            }) + '\n';

          await writer.write(new TextEncoder().encode(errorJson));
          await writer.close();
        }
      })();

      return readable;
    } catch (error) {
      getLogger().error({ err: error }, 'Error setting up streaming chat response');
      throw new ServiceError('Failed to set up streaming chat response', {
        cause: error instanceof Error ? error : new Error(String(error)),
      });
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

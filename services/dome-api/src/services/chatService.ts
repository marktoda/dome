import { Bindings } from '../types';
import { searchService, NoteSearchResult } from './searchService';
import { embeddingService } from './embeddingService';
import { ServiceError } from '@dome/common';

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
  /**
   * Generate a chat response
   * @param env Environment bindings
   * @param options Chat options
   * @returns Promise<string>
   */
  async generateResponse(env: Bindings, options: ChatOptions): Promise<string> {
    try {
      const {
        messages,
        userId,
        enhanceWithContext = true,
        maxContextItems = 5,
        includeSourceInfo = true,
        suggestAddCommand = true,
      } = options;

      // Get the last user message
      const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');

      if (!lastUserMessage) {
        throw new ServiceError('At least one user message is required');
      }

      // Retrieve relevant context if enhanceWithContext is true
      let context: NoteSearchResult[] = [];
      if (enhanceWithContext) {
        context = await this.retrieveContext(env, userId, lastUserMessage.content, maxContextItems);
      }

      // Format context for inclusion in the prompt
      const formattedContext = this.formatContextForPrompt(context, includeSourceInfo);

      // Check if user is asking to remember something
      const isRememberRequest = this.isAskingToRemember(lastUserMessage.content);

      // Create a system message with context if available
      const systemMessage: ChatMessage = {
        role: 'system',
        content: this.createSystemPrompt(formattedContext, isRememberRequest, suggestAddCommand),
      };

      // Combine system message with user messages
      const promptMessages = [systemMessage, ...messages];

      // Check if AI binding is available
      if (!env.AI) {
        throw new ServiceError('Workers AI binding is not available');
      }

      // Call Workers AI
      const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
        messages: promptMessages,
      });

      return response.response;
    } catch (error) {
      console.error('Error generating chat response:', error);
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
      const {
        messages,
        userId,
        enhanceWithContext = true,
        maxContextItems = 5,
        includeSourceInfo = true,
        suggestAddCommand = true,
      } = options;

      // Get the last user message
      const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');

      if (!lastUserMessage) {
        throw new ServiceError('At least one user message is required');
      }

      // Retrieve relevant context if enhanceWithContext is true
      let context: NoteSearchResult[] = [];
      if (enhanceWithContext) {
        context = await this.retrieveContext(env, userId, lastUserMessage.content, maxContextItems);
      }

      // Format context for inclusion in the prompt
      const formattedContext = this.formatContextForPrompt(context, includeSourceInfo);

      // Check if user is asking to remember something
      const isRememberRequest = this.isAskingToRemember(lastUserMessage.content);

      // Create a system message with context if available
      const systemMessage: ChatMessage = {
        role: 'system',
        content: this.createSystemPrompt(formattedContext, isRememberRequest, suggestAddCommand),
      };

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
          console.error('Error in stream chat:', error);

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
      console.error('Error setting up streaming chat response:', error);
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
  ): Promise<NoteSearchResult[]> {
    try {
      // Search for relevant notes
      const searchResults = await searchService.search(env, {
        userId,
        query,
        limit: maxItems,
      });

      return searchResults;
    } catch (error) {
      console.error('Error retrieving context:', error);
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
  private formatContextForPrompt(context: NoteSearchResult[], includeSourceInfo = true): string {
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
   * Check if the user is asking to remember something
   * @param message User message
   * @returns Boolean indicating if the user is asking to remember something
   */
  private isAskingToRemember(message: string): boolean {
    const rememberPatterns = [
      /remember\s+that/i,
      /make\s+a\s+note\s+of/i,
      /save\s+this/i,
      /keep\s+track\s+of/i,
      /add\s+to\s+my\s+notes/i,
      /write\s+down\s+that/i,
      /don't\s+forget\s+that/i,
      /remind\s+me\s+that/i,
      /store\s+this\s+information/i,
    ];

    return rememberPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Create a system prompt with context and instructions
   * @param formattedContext Formatted context string
   * @param isRememberRequest Whether the user is asking to remember something
   * @param suggestAddCommand Whether to suggest the /add command
   * @returns System prompt string
   */
  private createSystemPrompt(
    formattedContext: string,
    isRememberRequest: boolean,
    suggestAddCommand: boolean,
  ): string {
    let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";

    if (formattedContext) {
      prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedContext}\n\n`;
      prompt +=
        'When referencing information from these notes, include the note number in brackets, e.g., [1], to help the user identify the source.\n\n';
    }

    prompt +=
      'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';

    if (isRememberRequest && suggestAddCommand) {
      prompt +=
        '\n\nThe user seems to be asking you to remember something. At the end of your response, suggest they use the "/add" command to save this information to their knowledge base. For example: "To save this information, you can use the /add command followed by what you want to remember."';
    }

    return prompt;
  }
}

// Export singleton instance
export const chatService = new ChatService();

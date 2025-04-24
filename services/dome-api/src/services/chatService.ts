import { Bindings } from '../types';
import { SearchService } from './searchService';
import { logError, getLogger } from '@dome/logging';
import { PromptBuilder } from './promptBuilder';
import { LlmClient, AIMessage } from './llmClient';

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
 * Simplified service for chat operations
 */
export class ChatService {
  private logger;
  private searchService: SearchService;

  constructor(searchService: SearchService) {
    this.logger = getLogger();
    this.searchService = searchService;
  }

  /**
   * Build the prompt with context if needed
   * @param env Environment bindings
   * @param opts Chat options
   * @returns Promise resolving to an array of AI messages
   */
  private async buildPrompt(env: Bindings, opts: ChatOptions): Promise<AIMessage[]> {
    const { messages, userId, enhanceWithContext = true, maxContextItems = 10 } = opts;

    // Get the last user message
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');
    if (!lastUserMessage) {
      throw new Error('At least one user message is required');
    }

    // Retrieve context if enhanceWithContext is true
    let context: any[] = [];
    if (enhanceWithContext) {
      this.logger.info({ lastMessage: lastUserMessage }, 'Retrieving context for system prompt');
      context = await this.retrieveContext(env, userId, lastUserMessage.content, maxContextItems);
    }

    // Build the system prompt with context
    return [
      {
        role: 'system',
        content: PromptBuilder.build(context),
      },
      ...(messages as AIMessage[]),
    ];
  }

  /**
   * Generate a chat response (non-streaming)
   * @param env Environment bindings
   * @param options Chat options
   * @returns Promise resolving to the chat response
   */
  async generateResponse(env: Bindings, options: ChatOptions): Promise<string> {
    try {
      const messages = await this.buildPrompt(env, options);
      this.logger.info({ systemMessage: messages[0] }, 'Got system prompt');

      return await LlmClient.call(env, messages);
    } catch (error) {
      logError(error, 'Error generating chat response');

      // Return a fallback response instead of throwing
      return "I apologize, but I'm experiencing technical difficulties. Please try again later or contact support if the issue persists.";
    }
  }

  /**
   * Stream a chat response
   * @param env Environment bindings
   * @param options Chat options
   * @returns Promise resolving to a Response with a readable stream
   */
  async streamResponse(env: Bindings, options: ChatOptions): Promise<Response> {
    try {
      const messages = await this.buildPrompt(env, options);

      return await LlmClient.callStream(env, messages);
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId: options.userId,
          messageCount: options.messages.length,
          enhanceWithContext: options.enhanceWithContext,
        },
        'Error setting up streaming chat response',
      );

      // Return a fallback response
      return new Response(
        "I apologize, but I'm experiencing technical difficulties. Please try again later or contact support if the issue persists.",
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
  }

  /**
   * Retrieve context for RAG enhancement
   * @param env Environment bindings
   * @param userId User ID
   * @param query Query text
   * @param maxItems Maximum number of context items to retrieve
   * @returns Promise resolving to search results
   */
  private async retrieveContext(env: Bindings, userId: string, query: string, maxItems: number) {
    try {
      // Search for relevant content
      const searchResults = await this.searchService.search(env, {
        userId,
        query,
        limit: maxItems,
      });

      // Extract just the results array from the paginated response
      return searchResults?.results || [];
    } catch (error) {
      this.logger.error({ err: error, userId, query }, 'Error retrieving context');
      // Return empty context on error
      return [];
    }
  }
}

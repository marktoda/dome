import { Bindings } from '../types';
import { getLogger } from '@dome/logging';

/**
 * AI message interface
 */
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * LLM model configuration
 */
export const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Handles interactions with the AI service
 */
export class LlmClient {
  private static readonly logger = getLogger();
  private static readonly DEFAULT_TIMEOUT_MS = 15000; // 15 seconds

  /**
   * Execute a promise with a timeout
   * @param promise The promise to execute
   * @param timeoutMs Timeout in milliseconds
   * @returns Promise result
   */
  private static async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs = this.DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`AI call timed-out after ${timeoutMs} ms`)), timeoutMs),
      ),
    ]);
  }

  /**
   * Get a fallback response for when the AI service is unavailable
   * @returns Fallback response
   */
  static fallbackResponse(): string {
    return "I'm sorry, but I'm unable to process your request at the moment due to a technical issue. The AI service is currently unavailable. Please try again later.";
  }

  /**
   * Create a fallback Response object for streaming
   * @returns Response object with fallback message
   */
  static createFallbackResponse(): Response {
    return new Response(this.fallbackResponse(), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  /**
   * Check if we're in a test environment
   * @returns True if in test environment
   */
  private static isTestEnvironment(): boolean {
    return false;
  }

  /**
   * Get a mock response for testing
   * @returns Mock response
   */
  private static getMockResponse(): string {
    return 'This is a mock response for testing purposes.';
  }

  /**
   * Create a mock streaming response for testing
   * @returns Response object with mock streaming
   */
  private static createMockStreamingResponse(): Response {
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

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const text of mockResponses) {
          controller.enqueue(encoder.encode(text));
          // Add a small delay to simulate streaming
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  /**
   * Call the AI service with the given messages
   * @param env Environment bindings
   * @param messages Array of messages to send to the AI
   * @returns Promise resolving to the AI response
   */
  static async call(env: Bindings, messages: AIMessage[]): Promise<string> {
    // Check if AI binding is available
    if (!env.AI) {
      // In test environment, return a mock response
      if (this.isTestEnvironment()) {
        return this.getMockResponse();
      }

      this.logger.warn('Workers AI binding is not available, using fallback response');
      return this.fallbackResponse();
    }

    try {
      // Call Workers AI with timeout and error handling
      this.logger.info({ model: MODEL }, 'Calling Workers AI');
      const response = await this.withTimeout(env.AI.run(MODEL, { messages }));

      // Check if we have a valid response
      if (!response || !response.response) {
        this.logger.warn('AI returned an invalid or empty response, using fallback');
        return "I'm sorry, but I couldn't generate a proper response at this time. Please try again with a different question.";
      }

      this.logger.info({ responseLength: response.response.length }, 'Got valid AI response');
      return response.response;
    } catch (error) {
      this.logger.error({ err: error }, 'Error from AI service');

      // Provide a fallback response instead of throwing
      return "I'm sorry, but I encountered an issue while processing your request. The AI service is experiencing difficulties. Please try again later.";
    }
  }

  /**
   * Call the AI service with streaming
   * @param env Environment bindings
   * @param messages Array of messages to send to the AI
   * @returns Promise resolving to a Response with a readable stream
   */
  static async callStream(env: Bindings, messages: AIMessage[]): Promise<Response> {
    // Check if AI binding is available
    if (!env.AI) {
      // In test environment, return a mock streaming response
      if (this.isTestEnvironment()) {
        return this.createMockStreamingResponse();
      }

      this.logger.warn('Workers AI binding is not available, using fallback response');
      return this.createFallbackResponse();
    }

    try {
      // Call Workers AI with streaming
      this.logger.info(
        {
          model: MODEL,
          messageCount: messages.length,
          systemPromptLength: messages[0]?.content?.length || 0,
          lastUserMessageLength: messages[messages.length - 1]?.content?.length || 0,
        },
        'Calling Workers AI with streaming',
      );

      // Log the request details at debug level
      this.logger.debug(
        {
          model: MODEL,
          stream: true,
          messagesPreview: messages.map(m => ({
            role: m.role,
            contentLength: m.content.length,
            contentPreview: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
          })),
        },
        'AI streaming request details',
      );

      // Get the stream directly from Workers AI
      const stream = await env.AI.run(MODEL, {
        messages,
        stream: true,
      });

      // Return the stream with proper headers
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Error from AI streaming service');
      return this.createFallbackResponse();
    }
  }
}

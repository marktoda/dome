import { Bindings } from '../types';
import { SearchService } from './searchService';
import { getLogger } from '@dome/logging';
import { AIMessage } from './llmClient';

/**
 * Chat options interface
 */
export interface ChatOptions {
  messages: AIMessage[];
  userId: string;
  enhanceWithContext?: boolean;
  maxContextItems?: number;
  includeSourceInfo?: boolean;
  suggestAddCommand?: boolean;
}

/**
 * Model to use for chat
 */
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * Helper function for fallback response
 */
function fallback(): string {
  return "I'm sorry, but I'm unable to process your request at the moment due to a technical issue. The AI service is currently unavailable. Please try again later.";
}

/**
 * Helper function for fallback response as Response object
 */
function fallbackResponse(): Response {
  return new Response(fallback(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

/**
 * Helper function to wrap a promise with a timeout
 */
async function withTimeout<T>(p: Promise<T>, ms = 15_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, r) => setTimeout(() => r(
      new Error(`AI call timed-out after ${ms} ms`)
    ), ms)),
  ]);
}

/**
 * Prompt builder class
 */
class PromptBuilder {
  /**
   * Build a system prompt with context
   */
  static build(context: any[]): string {
    let prompt = "You are an AI assistant with access to the user's personal knowledge base. ";

    if (context.length > 0) {
      const formattedContext = context
        .map((item, index) => {
          const formattedDate = new Date(item.createdAt).toISOString().split('T')[0];
          const sourceInfo = `\n[Source: Note ID ${item.id}, created ${formattedDate}]`;
          return `[${index + 1}] ${item.title}\n${item.body}${sourceInfo}`;
        })
        .join('\n\n');

      prompt += `Here is relevant information from the user's notes that may help with the response:\n\n${formattedContext}\n\n`;
      prompt += 'When referencing information from these notes, include the note number in brackets, e.g., [1], to help the user identify the source.\n\n';
    }

    prompt += 'Provide a helpful, accurate, and concise response based on the provided context and your knowledge.';

    return prompt;
  }
}

/**
 * Minimal implementation of the chat service
 */
export class SimpleChatService {
  constructor(
    private search: SearchService,
    private logger = getLogger()
  ) {}

  /**
   * Build the prompt with context if needed
   */
  private async buildPrompt(env: Bindings, opts: ChatOptions): Promise<AIMessage[]> {
    let ctx: any[] = [];
    if (opts.enhanceWithContext) {
      const searchResults = await this.search.search(env, {
        userId: opts.userId,
        query: opts.messages.at(-1)!.content,
        limit: 8
      });
      ctx = searchResults?.results || [];
    }
    
    return [
      {
        role: "system",
        content: PromptBuilder.build(ctx),
      },
      ...opts.messages,
    ];
  }

  /**
   * Non-streaming chat response
   */
  async reply(env: Bindings, opts: ChatOptions): Promise<string> {
    if (!env.AI) return fallback();
    const messages = await this.buildPrompt(env, opts);
    const { response } = await withTimeout(
      env.AI.run(MODEL, { messages }),
    );
    return response;
  }

  /**
   * Streaming chat response
   */
  async replyStream(env: Bindings, opts: ChatOptions): Promise<Response> {
    if (!env.AI) return fallbackResponse();
    const messages = await this.buildPrompt(env, opts);
    const stream = await env.AI.run(MODEL, { messages, stream: true });
    return new Response(stream, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
import { SearchResult } from './searchService';
import { getLogger } from '@dome/common';
import { encoding_for_model } from '@dqbd/tiktoken';

/**
 * Responsible for building prompts with token awareness and RAG context injection
 */
export class PromptBuilder {
  // Maximum context window size for the model (in tokens)
  private static readonly MAX_CONTEXT_WINDOW = 24000;
  // Reserve tokens for the model's response
  private static readonly RESPONSE_TOKEN_RESERVE = 2000;
  // Maximum system prompt size in tokens
  private static readonly MAX_SYSTEM_PROMPT_TOKENS =
    PromptBuilder.MAX_CONTEXT_WINDOW - PromptBuilder.RESPONSE_TOKEN_RESERVE;

  private static readonly logger = getLogger();

  /**
   * Count tokens in a text using the tokenizer
   * @param text The text to count tokens for
   * @returns Token count
   */
  static countTokens(text: string): number {
    const encoder = encoding_for_model('gpt-3.5-turbo');
    const tokens = encoder.encode(text);
    const count = tokens.length;
    encoder.free();
    return count;
  }

  /**
   * Truncate text to fit within a token limit
   * @param text Text to truncate
   * @param maxTokens Maximum tokens allowed
   * @returns Truncated text
   */
  static truncateToTokenLimit(text: string, maxTokens: number): string {
    const tokenCount = this.countTokens(text);
    if (tokenCount <= maxTokens) {
      return text;
    }

    // Simple truncation approach - we'll truncate by percentage and check again
    // This is more efficient than character-by-character truncation
    const truncationRatio = (maxTokens / tokenCount) * 0.9; // 90% of ideal to be safe
    const truncatedText =
      text.substring(0, Math.floor(text.length * truncationRatio)) +
      '... [truncated due to length]';

    // Verify the truncation worked
    const newTokenCount = this.countTokens(truncatedText);
    if (newTokenCount <= maxTokens) {
      return truncatedText;
    }

    // If still too long, use a more aggressive truncation
    return (
      text.substring(0, Math.floor(text.length * truncationRatio * 0.8)) +
      '... [truncated due to length]'
    );
  }

  /**
   * Format context for inclusion in the prompt
   * @param context Context from search results
   * @param includeSourceInfo Whether to include source information
   * @returns Formatted context string
   */
  static formatContextForPrompt(context: SearchResult[], includeSourceInfo = true): string {
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
  static createSystemPrompt(formattedContext: string): string {
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

  /**
   * Build a complete system prompt with context
   * @param context Search results to include as context
   * @returns The built system prompt
   */
  static build(context: SearchResult[]): string {
    const formattedContext = this.formatContextForPrompt(context);

    // Log context size information
    const contextTokens = this.countTokens(formattedContext);
    this.logger.info(
      {
        contextLength: formattedContext.length,
        tokenCount: contextTokens,
        maxAllowed: this.MAX_SYSTEM_PROMPT_TOKENS,
      },
      'Building system prompt with context',
    );

    // Limit context size if it's too large
    let finalContext = formattedContext;
    if (contextTokens > this.MAX_SYSTEM_PROMPT_TOKENS) {
      this.logger.warn(
        {
          originalLength: formattedContext.length,
          originalTokens: contextTokens,
        },
        'Context is too large, truncating',
      );

      finalContext = this.truncateToTokenLimit(formattedContext, this.MAX_SYSTEM_PROMPT_TOKENS);

      this.logger.info(
        {
          newLength: finalContext.length,
          newTokens: this.countTokens(finalContext),
        },
        'Context truncated',
      );
    }

    // Create the final system prompt
    const systemPrompt = this.createSystemPrompt(finalContext);

    this.logger.info(
      {
        systemPromptLength: systemPrompt.length,
        tokenCount: this.countTokens(systemPrompt),
      },
      'Created system prompt',
    );

    return systemPrompt;
  }
}

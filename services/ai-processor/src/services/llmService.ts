import { getLogger } from '@dome/logging';
import { Ai } from '../types';

/**
 * LLM Service for processing content with AI
 * Handles different content types with specialized prompts
 */
export class LlmService {
  constructor(private ai: Ai) {}

  /**
   * Process content with LLM based on content type
   * @param content The content to process
   * @param contentType The type of content (note, code, article, etc.)
   * @returns Enriched metadata from LLM processing
   */
  async processContent(content: string, contentType: string): Promise<any> {
    try {
      // Select the appropriate prompt based on content type
      const prompt = this.getPromptForContentType(content, contentType);

      // Process with LLM
      getLogger().debug(
        { contentType, contentLength: content.length },
        'Processing content with LLM',
      );

      const response = await this.ai.run('@cf/meta/llama-3-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
      });

      // Parse and validate the response
      const metadata = this.parseResponse(response.response);

      getLogger().info(
        {
          contentType,
          hasSummary: !!metadata.summary,
          hasTodos: Array.isArray(metadata.todos) && metadata.todos.length > 0,
          hasReminders: Array.isArray(metadata.reminders) && metadata.reminders.length > 0,
          topics: metadata.topics,
        },
        'Successfully processed content with LLM',
      );

      return {
        ...metadata,
        processingVersion: 1,
        modelUsed: '@cf/meta/llama-3-8b-instruct',
      };
    } catch (error) {
      getLogger().error(
        { error, contentType, contentLength: content.length },
        'Error processing content with LLM',
      );

      // Return minimal metadata on error
      return {
        title: this.generateFallbackTitle(content),
        summary: 'Content processing failed',
        processingVersion: 1,
        modelUsed: '@cf/meta/llama-3-8b-instruct',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the appropriate prompt for the content type
   * @param content The content to process
   * @param contentType The type of content
   * @returns Prompt string for the LLM
   */
  private getPromptForContentType(content: string, contentType: string): string {
    switch (contentType) {
      case 'note':
        return this.getNotePrompt(content);
      case 'code':
        return this.getCodePrompt(content);
      case 'article':
        return this.getArticlePrompt(content);
      default:
        return this.getDefaultPrompt(content);
    }
  }

  /**
   * Get prompt for processing notes
   * @param content The note content
   * @returns Prompt string for the LLM
   */
  private getNotePrompt(content: string): string {
    return `
      Analyze the following note and extract:
      1. A concise title (max 5-7 words)
      2. A concise summary (max 2-3 sentences)
      3. Any TODOs mentioned (with priority and due dates if specified)
      4. Any reminders mentioned (with times if specified)
      5. Key topics or categories
      
      Format the response as a JSON object with the following structure:
      {
        "title": "...",
        "summary": "...",
        "todos": [{"text": "...", "dueDate": "...", "priority": "..."}],
        "reminders": [{"text": "...", "reminderTime": "..."}],
        "topics": ["topic1", "topic2"]
      }
      
      Note:
      ${this.truncateContent(content, 8000)}
    `;
  }

  /**
   * Get prompt for processing code
   * @param content The code content
   * @returns Prompt string for the LLM
   */
  private getCodePrompt(content: string): string {
    return `
      Analyze the following code and extract:
      1. A concise title describing what this code does (max 5-7 words)
      2. A concise description of what this code does (max 2-3 sentences)
      3. Any TODOs in comments
      4. Key functions/classes/components
      5. Programming language and frameworks used
      
      Format the response as a JSON object with the following structure:
      {
        "title": "...",
        "summary": "...",
        "todos": [{"text": "...", "location": "..."}],
        "components": ["component1", "component2"],
        "language": "...",
        "frameworks": ["framework1", "framework2"],
        "topics": ["topic1", "topic2"]
      }
      
      Code:
      ${this.truncateContent(content, 8000)}
    `;
  }

  /**
   * Get prompt for processing articles
   * @param content The article content
   * @returns Prompt string for the LLM
   */
  private getArticlePrompt(content: string): string {
    return `
      Analyze the following article and extract:
      1. A concise title (max 5-7 words)
      2. A concise summary (3-5 sentences)
      3. Key points or takeaways
      4. Main topics or categories
      5. Entities mentioned (people, organizations, products)
      
      Format the response as a JSON object with the following structure:
      {
        "title": "...",
        "summary": "...",
        "keyPoints": ["point1", "point2"],
        "topics": ["topic1", "topic2"],
        "entities": {
          "people": ["person1", "person2"],
          "organizations": ["org1", "org2"],
          "products": ["product1", "product2"]
        }
      }
      
      Article:
      ${this.truncateContent(content, 8000)}
    `;
  }

  /**
   * Get default prompt for unknown content types
   * @param content The content to process
   * @returns Prompt string for the LLM
   */
  private getDefaultPrompt(content: string): string {
    // Fallback prompt for unknown content types
    return `
      Analyze the following content and extract:
      1. A concise title (max 5-7 words)
      2. A concise summary (max 2-3 sentences)
      3. Key topics or categories
      
      Format the response as a JSON object with the following structure:
      {
        "title": "...",
        "summary": "...",
        "topics": ["topic1", "topic2"]
      }
      
      Content:
      ${this.truncateContent(content, 8000)}
    `;
  }

  /**
   * Parse the LLM response into a structured object
   * @param response The raw response from the LLM
   * @returns Parsed metadata object
   */
  private parseResponse(response: string): any {
    try {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? jsonMatch[0] : response;

      return JSON.parse(jsonString);
    } catch (error) {
      getLogger().error(
        { error, response: response.substring(0, 200) + '...' },
        'Failed to parse LLM response',
      );

      // Return a minimal valid object
      return {
        title: 'Untitled Content',
        summary: 'Failed to generate summary from content',
        error: 'Response parsing failed',
      };
    }
  }

  /**
   * Generate a fallback title when processing fails
   * @param content The original content
   * @returns A simple title based on the first line or characters
   */
  private generateFallbackTitle(content: string): string {
    try {
      // Try to use the first line as title
      const firstLine = content.split('\n')[0].trim();
      if (firstLine && firstLine.length <= 50) {
        return firstLine;
      }

      // Otherwise use the first few characters
      return content.substring(0, 40).trim() + '...';
    } catch (error) {
      return 'Untitled Content';
    }
  }

  /**
   * Truncate content to fit within LLM context window
   * @param content The content to truncate
   * @param maxLength Maximum length to allow
   * @returns Truncated content
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    getLogger().info(
      { originalLength: content.length, truncatedLength: maxLength },
      'Truncating content to fit LLM context window',
    );

    return content.substring(0, maxLength) + '\n\n[Content truncated due to length limitations]';
  }
}

/**
 * Create a new LLM service instance
 * @param ai The AI binding
 * @returns A new LLM service instance
 */
export function createLlmService(ai: Ai): LlmService {
  return new LlmService(ai);
}

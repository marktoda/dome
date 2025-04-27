import { getLogger, logError, trackOperation } from '../utils/logging';
import { toDomeError, LLMProcessingError, assertValid } from '../utils/errors';

/**
 * LLM Service for processing content with AI
 * Handles different content types with specialized prompts
 */
export class LlmService {
  private readonly MODEL_NAME = '@cf/google/gemma-7b-it-lora';
  private readonly MAX_RETRY_ATTEMPTS = 2;
  private readonly logger = getLogger().child({ component: 'LlmService' });

  constructor(private env: Env) {}

  /**
   * Process content with LLM based on content type
   * @param content The content to process
   * @param contentType The type of content (note, code, article, etc.)
   * @returns Enriched metadata from LLM processing
   */
  async processContent(content: string, contentType: string): Promise<any> {
    // Validate inputs
    assertValid(!!content, 'Content is required for LLM processing', { contentType });
    assertValid(!!contentType, 'Content type is required for LLM processing');
    
    const requestId = crypto.randomUUID();
    
    return trackOperation(
      'llm_process_content',
      async () => {
        try {
          // Select the appropriate prompt based on content type
          const prompt = this.getPromptForContentType(content, contentType);

          // Add detailed context for all logs
          const logContext = {
            contentType,
            contentLength: content.length,
            requestId,
            modelName: this.MODEL_NAME
          };
          
          this.logger.debug(
            logContext,
            'Processing content with LLM',
          );

          // Attempt to process with LLM with retry logic
          let lastError = null;
          let attempt = 0;
          
          while (attempt <= this.MAX_RETRY_ATTEMPTS) {
            try {
              // Perform the LLM call
              const raw = await this.env.AI.run(this.MODEL_NAME, {
                messages: [{ role: 'user', content: prompt }],
                stream: false,
              });

              if (raw instanceof ReadableStream) {
                throw new LLMProcessingError('Unexpected streaming response', { requestId });
              }

              // Parse and validate the response
              const metadata = this.parseResponse(raw.response || '', requestId);

              // Log success with detailed metrics
              this.logger.info(
                {
                  ...logContext,
                  hasSummary: !!metadata.summary,
                  summaryLength: metadata.summary ? metadata.summary.length : 0,
                  hasTodos: Array.isArray(metadata.todos) && metadata.todos.length > 0,
                  todoCount: Array.isArray(metadata.todos) ? metadata.todos.length : 0,
                  hasReminders: Array.isArray(metadata.reminders) && metadata.reminders.length > 0,
                  reminderCount: Array.isArray(metadata.reminders) ? metadata.reminders.length : 0,
                  hasTopics: Array.isArray(metadata.topics) && metadata.topics.length > 0,
                  topicCount: Array.isArray(metadata.topics) ? metadata.topics.length : 0,
                  attempt: attempt + 1,
                  responseLength: raw.response ? raw.response.length : 0
                },
                'Successfully processed content with LLM',
              );

              return {
                ...metadata,
                processingVersion: 1,
                modelUsed: this.MODEL_NAME,
              };
            } catch (error) {
              lastError = error;
              
              // Check if we should retry
              if (attempt < this.MAX_RETRY_ATTEMPTS) {
                const backoffMs = Math.pow(2, attempt) * 100; // Exponential backoff
                
                this.logger.warn({
                  ...logContext,
                  attempt: attempt + 1,
                  maxAttempts: this.MAX_RETRY_ATTEMPTS,
                  error: error instanceof Error ? error.message : String(error),
                  backoffMs
                }, `LLM processing attempt failed, retrying in ${backoffMs}ms`);
                
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                attempt++;
              } else {
                break;
              }
            }
          }
          
          // All retries failed
          const domeError = toDomeError(
            lastError,
            `All LLM processing attempts failed for content type: ${contentType}`,
            {
              ...logContext,
              attemptsMade: attempt + 1
            }
          );
          
          logError(domeError, 'LLM processing failed after all retry attempts');

          // Return minimal metadata on error
          return {
            title: this.generateFallbackTitle(content),
            summary: 'Content processing failed',
            processingVersion: 1,
            modelUsed: this.MODEL_NAME,
            error: domeError.message,
            errorCode: domeError.code,
          };
        } catch (error) {
          const domeError = toDomeError(
            error,
            `Error in LLM processing for content type: ${contentType}`,
            {
              contentType,
              contentLength: content.length,
              requestId
            }
          );
          
          logError(domeError, 'Unexpected error in LLM processing');

          // Return minimal metadata on error
          return {
            title: this.generateFallbackTitle(content),
            summary: 'Content processing failed',
            processingVersion: 1,
            modelUsed: this.MODEL_NAME,
            error: domeError.message,
            errorCode: domeError.code,
          };
        }
      },
      { contentType, contentLength: content.length, requestId }
    );
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
        "todos": [{"text": "...", "dueDate": "...", "priority": "high|medium|low"}],
        "reminders": [{"text": "...", "reminderTime": "..."}],
        "topics": ["topic1", "topic2"]
      }

      Note that priority values must be lowercase: "high", "medium", or "low".

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
  /**
   * Parse the LLM response into a structured object
   * @param response The raw response from the LLM
   * @param requestId Request ID for correlation
   * @returns Parsed metadata object
   */
  private parseResponse(response: string, requestId: string): any {
    return trackOperation(
      'parse_llm_response',
      async () => {
        try {
          // Try to extract JSON from the response, handling markdown code blocks
          let jsonString = response;

          // Check if response is wrapped in markdown code blocks
          const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (codeBlockMatch && codeBlockMatch[1]) {
            jsonString = codeBlockMatch[1];
          } else {
            // Fall back to the original curly brace matching if no code block is found
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              jsonString = jsonMatch[0];
            }
          }

          // Attempt to fix common JSON syntax errors before parsing
          jsonString = this.sanitizeJsonString(jsonString);

          try {
            const parsed = JSON.parse(jsonString);

            // Validate essential fields
            assertValid(
              !!parsed.title && typeof parsed.title === 'string',
              'Parsed response missing valid title field',
              { requestId }
            );
            
            assertValid(
              !!parsed.summary && typeof parsed.summary === 'string',
              'Parsed response missing valid summary field',
              { requestId }
            );

            // Normalize priority values to lowercase
            if (parsed.todos && Array.isArray(parsed.todos)) {
              parsed.todos = parsed.todos.map((todo: { priority?: string; [key: string]: any }) => {
                if (todo.priority) {
                  todo.priority = todo.priority.toLowerCase();
                }
                return todo;
              });
            }

            return parsed;
          } catch (parseError) {
            this.logger.warn(
              {
                error: parseError instanceof Error ? parseError.message : String(parseError),
                fallback: true,
                requestId
              },
              'Standard JSON parsing failed, attempting fallback extraction'
            );
            
            // If standard parsing fails, try a more aggressive approach
            // or fallback to a best-effort manual extraction
            return this.extractStructuredData(jsonString, requestId);
          }
        } catch (error) {
          const domeError = toDomeError(
            error,
            'Failed to parse LLM response',
            {
              requestId,
              hasCodeBlock: response.includes('```'),
              responseLength: response.length,
              responseSample: response.substring(0, 100) + '...',
              operation: 'parseResponse'
            }
          );
          
          logError(domeError, 'Failed to parse LLM response');

          // Return a minimal valid object
          return {
            title: 'Untitled Content',
            summary: 'Failed to generate summary from content',
            error: 'Response parsing failed',
            errorCode: domeError.code,
          };
        }
      },
      { responseLength: response.length, requestId }
    );
  }

  /**
   * Sanitize a JSON string to fix common syntax errors
   * @param jsonString The JSON string to sanitize
   * @returns A sanitized JSON string
   */
  private sanitizeJsonString(jsonString: string): string {
    // Trim whitespace
    let sanitized = jsonString.trim();

    // Fix trailing commas in arrays and objects
    sanitized = sanitized.replace(/,\s*([}\]])/g, '$1');

    // Fix missing commas between array elements or object properties
    sanitized = sanitized.replace(/}\s*{/g, '},{');
    sanitized = sanitized.replace(/]\s*\[/g, '],[');
    sanitized = sanitized.replace(/"\s*"/g, '","');

    // Fix unquoted property names
    sanitized = sanitized.replace(/([{,]\s*)([a-zA-Z0-9_$]+)(\s*:)/g, '$1"$2"$3');

    // Fix single quotes to double quotes (careful with nested quotes)
    sanitized = sanitized.replace(/'([^']*?)'/g, '"$1"');

    return sanitized;
  }

  /**
   * Extract structured data from a potentially malformed JSON string
   * @param jsonString The JSON string to extract data from
   * @returns A best-effort structured object
   */
  /**
   * Extract structured data from a potentially malformed JSON string
   * @param jsonString The JSON string to extract data from
   * @param requestId Request ID for correlation
   * @returns A best-effort structured object
   */
  private extractStructuredData(jsonString: string, requestId: string): any {
    const result: any = {
      title: 'Untitled Content',
      summary: 'Content extracted with best-effort parsing',
    };

    try {
      // Track fields we successfully extract
      const extractedFields: string[] = [];

      // Extract title using regex
      const titleMatch = jsonString.match(/"title"\s*:\s*"([^"]+)"/);
      if (titleMatch && titleMatch[1]) {
        result.title = titleMatch[1];
        extractedFields.push('title');
      }

      // Extract summary using regex
      const summaryMatch = jsonString.match(/"summary"\s*:\s*"([^"]+)"/);
      if (summaryMatch && summaryMatch[1]) {
        result.summary = summaryMatch[1];
        extractedFields.push('summary');
      }

      // Extract todos if present (simplified approach)
      const todosMatch = jsonString.match(/"todos"\s*:\s*\[(.*?)\]/s);
      if (todosMatch && todosMatch[1]) {
        const todoItems = todosMatch[1].split('},');
        result.todos = todoItems.map(item => {
          const textMatch = item.match(/"text"\s*:\s*"([^"]+)"/);
          const locationMatch = item.match(/"location"\s*:\s*"([^"]+)"/);
          const priorityMatch = item.match(/"priority"\s*:\s*"([^"]+)"/);
          const dueDateMatch = item.match(/"dueDate"\s*:\s*"([^"]+)"/);

          return {
            text: textMatch ? textMatch[1] : 'Unknown todo',
            location: locationMatch ? locationMatch[1] : '',
            priority: priorityMatch ? priorityMatch[1].toLowerCase() : 'medium',
            dueDate: dueDateMatch ? dueDateMatch[1] : undefined
          };
        });
        extractedFields.push('todos');
      }

      // Extract reminders if present
      const remindersMatch = jsonString.match(/"reminders"\s*:\s*\[(.*?)\]/s);
      if (remindersMatch && remindersMatch[1]) {
        const reminderItems = remindersMatch[1].split('},');
        result.reminders = reminderItems.map(item => {
          const textMatch = item.match(/"text"\s*:\s*"([^"]+)"/);
          const timeMatch = item.match(/"reminderTime"\s*:\s*"([^"]+)"/);

          return {
            text: textMatch ? textMatch[1] : 'Unknown reminder',
            reminderTime: timeMatch ? timeMatch[1] : undefined
          };
        });
        extractedFields.push('reminders');
      }

      // Extract topics if present
      const topicsMatch = jsonString.match(/"topics"\s*:\s*\[(.*?)\]/s);
      if (topicsMatch && topicsMatch[1]) {
        result.topics = topicsMatch[1]
          .split(',')
          .map(topic => {
            const cleaned = topic.trim().replace(/^"/, '').replace(/"$/, '');
            return cleaned || 'Unknown topic';
          })
          .filter(Boolean);
        extractedFields.push('topics');
      }

      // Extract key points if present (for articles)
      const keyPointsMatch = jsonString.match(/"keyPoints"\s*:\s*\[(.*?)\]/s);
      if (keyPointsMatch && keyPointsMatch[1]) {
        result.keyPoints = keyPointsMatch[1]
          .split(',')
          .map(point => {
            const cleaned = point.trim().replace(/^"/, '').replace(/"$/, '');
            return cleaned || 'Unknown point';
          })
          .filter(Boolean);
        extractedFields.push('keyPoints');
      }

      this.logger.info(
        {
          extractedFields,
          fieldCount: extractedFields.length,
          requestId,
          operation: 'extractStructuredData'
        },
        'Extracted structured data using fallback method',
      );

      return result;
    } catch (error) {
      const domeError = toDomeError(
        error,
        'Error in fallback structured data extraction',
        { requestId, operation: 'extractStructuredData' }
      );
      
      logError(domeError, 'Failed to extract structured data with fallback method');
      return result;
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
export function createLlmService(env: Env): LlmService {
  return new LlmService(env);
}

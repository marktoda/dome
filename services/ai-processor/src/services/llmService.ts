import { getLogger, logError, trackOperation } from '../utils/logging';
import { toDomeError, LLMProcessingError, assertValid } from '../utils/errors';
import { getSchemaForContentType, getSchemaInstructions } from '../schemas';

/**
 * Factory function to create an LLM service instance
 * @param env Environment variables
 * @returns LLM service instance
 */
export function createLlmService(env: Env): LlmService {
  return new LlmService(env);
}

/**
 * LLM Service for processing content with AI
 * Handles different content types with specialized prompts and structured output schemas
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
          // Get the appropriate schema and instructions for this content type
          const schema = getSchemaForContentType(contentType);
          const schemaInstructions = getSchemaInstructions(contentType);

          // Get the truncated content for the prompt
          const truncatedContent = this.truncateContent(content, 8000);

          // Add detailed context for all logs
          const logContext = {
            contentType,
            contentLength: content.length,
            requestId,
            modelName: this.MODEL_NAME,
          };

          this.logger.debug(logContext, 'Processing content with LLM using structured schema');

          // Attempt to process with LLM with retry logic
          let lastError = null;
          let attempt = 0;

          while (attempt <= this.MAX_RETRY_ATTEMPTS) {
            try {
              // Create the prompt with content type-specific instructions
              const prompt = `${schemaInstructions}\n\n${contentType.toUpperCase()} CONTENT:\n${truncatedContent}`;

              // Perform the LLM call
              const raw = await this.env.AI.run(this.MODEL_NAME, {
                messages: [{ role: 'user', content: prompt }],
                stream: false,
              });

              if (raw instanceof ReadableStream) {
                throw new LLMProcessingError('Unexpected streaming response', { requestId });
              }

              this.logger.info({ raw }, 'RAW LLM processing response received');

              // Parse and validate the response using the schema
              let parsedResponse;
              let validationError = null;

              try {
                // Attempt to extract JSON from the response if it's wrapped in markdown
                let jsonContent = raw.response || '';
                const codeBlockMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (codeBlockMatch && codeBlockMatch[1]) {
                  jsonContent = codeBlockMatch[1];
                }

                // Try to parse as JSON
                const jsonData = JSON.parse(jsonContent);

                // Validate against schema
                parsedResponse = schema.parse(jsonData);
              } catch (err) {
                validationError = err;
                throw new LLMProcessingError('Failed to parse structured response', {
                  requestId,
                  error: err instanceof Error ? err.message : String(err),
                  response: raw.response,
                });
              }

              // Log success with detailed metrics
              this.logger.info(
                {
                  ...logContext,
                  hasSummary: !!parsedResponse.summary,
                  summaryLength: parsedResponse.summary ? parsedResponse.summary.length : 0,
                  hasTodos: Array.isArray(parsedResponse.todos) && parsedResponse.todos.length > 0,
                  todoCount: Array.isArray(parsedResponse.todos) ? parsedResponse.todos.length : 0,
                  hasReminders:
                    Array.isArray(parsedResponse.reminders) && parsedResponse.reminders.length > 0,
                  reminderCount: Array.isArray(parsedResponse.reminders)
                    ? parsedResponse.reminders.length
                    : 0,
                  hasTopics:
                    Array.isArray(parsedResponse.topics) && parsedResponse.topics.length > 0,
                  topicCount: Array.isArray(parsedResponse.topics)
                    ? parsedResponse.topics.length
                    : 0,
                  attempt: attempt + 1,
                  responseLength: raw.response ? raw.response.length : 0,
                },
                'Successfully processed content with structured schema',
              );

              return {
                ...parsedResponse,
                processingVersion: 2, // Updated version to indicate structured schema usage
                modelUsed: this.MODEL_NAME,
              };
            } catch (error) {
              lastError = error;

              // Check if this is a rate limit error
              const isRateLimit =
                error instanceof Error &&
                (error.message.includes('Capacity temporarily exceeded') ||
                  error.message.includes('3040'));

              // Check if we should retry
              if (attempt < this.MAX_RETRY_ATTEMPTS) {
                const backoffMs = Math.pow(2, attempt) * 100; // Exponential backoff

                this.logger.warn(
                  {
                    ...logContext,
                    attempt: attempt + 1,
                    maxAttempts: this.MAX_RETRY_ATTEMPTS,
                    error: error instanceof Error ? error.message : String(error),
                    isRateLimit,
                    backoffMs,
                  },
                  `LLM processing attempt failed, retrying in ${backoffMs}ms`,
                );

                await new Promise(resolve => setTimeout(resolve, backoffMs));
                attempt++;
              } else if (isRateLimit && 'RATE_LIMIT_DLQ' in this.env) {
                // We've exhausted retries and it's a rate limit error - send to DLQ
                try {
                  // Create a message with necessary info for later processing
                  const dlqMessage = {
                    contentType,
                    content,
                    requestId: logContext.requestId,
                    timestamp: Date.now(),
                    error: error instanceof Error ? error.message : String(error),
                    retryCount: attempt,
                    // Include a reference key to help with debugging
                    source: 'llm_rate_limit',
                    contentLength: content.length,
                  };

                  // Send to rate limit DLQ
                  this.logger.info(
                    {
                      queueName: 'RATE_LIMIT_DLQ',
                      contentType,
                      retryCount: attempt,
                      contentLength: content.length,
                      requestId: logContext.requestId,
                    },
                    'Sending rate-limited content to DLQ for later processing',
                  );

                  const result = await (this.env as any).RATE_LIMIT_DLQ.send(dlqMessage);

                  // Verify send was successful by checking result
                  if (!result) {
                    throw new Error('Failed to send message to rate limit DLQ');
                  }

                  this.logger.info(
                    {
                      ...logContext,
                      queue: 'RATE_LIMIT_DLQ',
                    },
                    'Rate-limited content queued for later processing',
                  );

                  // Return a specific response indicating it's queued for later
                  return {
                    title: this.generateFallbackTitle(content),
                    summary: 'Processing scheduled for later due to high demand',
                    processingVersion: 2,
                    modelUsed: this.MODEL_NAME,
                    status: 'QUEUED_FOR_RETRY',
                    queuedAt: new Date().toISOString(),
                  };
                } catch (dlqError) {
                  this.logger.error(
                    {
                      ...logContext,
                      dlqError: dlqError instanceof Error ? dlqError.message : String(dlqError),
                    },
                    'Failed to send rate-limited content to DLQ',
                  );
                  // Continue to standard fallback response
                }

                break;
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
              attemptsMade: attempt + 1,
            },
          );

          logError(domeError, 'LLM processing failed after all retry attempts');

          // Return minimal metadata on error
          return {
            title: this.generateFallbackTitle(content),
            summary: 'Content processing failed',
            processingVersion: 2,
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
              requestId,
            },
          );

          logError(domeError, 'Unexpected error in LLM processing');

          // Return minimal metadata on error
          return {
            title: this.generateFallbackTitle(content),
            summary: 'Content processing failed',
            processingVersion: 2,
            modelUsed: this.MODEL_NAME,
            error: domeError.message,
            errorCode: domeError.code,
          };
        }
      },
      { contentType, contentLength: content.length, requestId },
    );
  }

  /**
   * Generate a fallback title from content
   * @param content The content to extract a title from
   * @returns A simple title based on the first line
   */
  private generateFallbackTitle(content: string): string {
    try {
      // Get the first line and trim it
      const firstLine = content.split('\n')[0].trim();

      // Limit to first 50 characters
      const title = firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;

      return title || 'Untitled Content';
    } catch (error) {
      return 'Untitled Content';
    }
  }

  /**
   * Truncate content to a specified maximum length
   * @param content The content to truncate
   * @param maxLength The maximum length to return
   * @returns Truncated content
   */
  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }

    this.logger.debug(
      { originalLength: content.length, truncatedLength: maxLength },
      'Truncating content for LLM processing',
    );

    // Simple truncation with indicator
    return content.substring(0, maxLength) + '... [content truncated]';
  }
}

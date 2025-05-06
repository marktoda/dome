import { getLogger, logError, trackOperation } from '../utils/logging';
import { toDomeError, LLMProcessingError, assertValid } from '../utils/errors';
import { getSchemaForContentType, getSchemaInstructions } from '../schemas';

/** Factory */
export function createLlmService(env: Env): LlmService {
  return new LlmService(env);
}

/**
 * LLM Service – flat control‑flow, minimal nested try/catch
 */
export class LlmService {
  private static readonly DEFAULT_MODEL_NAME = '@cf/google/gemma-3-12b-it' as const;
  private static readonly MAX_RETRY_ATTEMPTS = 2;

  // Model-specific token limits
  private static readonly MODEL_TOKEN_LIMITS: Record<string, number> = {
    '@cf/google/gemma-7b-it-lora': 8000,
    '@cf/meta/llama-2-7b-chat-int8': 4000,
    '@cf/mistral/mistral-7b-instruct-v0.1': 8000,
    '@cf/meta/llama-3-8b-instruct': 16000,
    '@cf/meta/llama-3-70b-instruct': 32000,
    '@cf/google/gemma-3-12b-it': 70000,
  };

  private readonly logger = getLogger().child({ component: 'LlmService' });

  constructor(private readonly env: Env) { }

  /**
   * Process content with LLM
   * @param content The content body to process
   * @param contentType The type of content (note, email, etc)
   * @param existingMetadata Optional existing metadata to include as context
   */
  async processContent(
    content: string,
    contentType: string,
    existingMetadata?: {
      title?: string;
      summary?: string;
      tags?: string[];
    }
  ) {
    assertValid(!!content, 'Content is required for LLM processing', { contentType });
    assertValid(!!contentType, 'Content type is required for LLM processing');

    const requestId = crypto.randomUUID();
    // Get model from environment or use default
    const modelName = this.getModelName();

    const logContext = {
      requestId,
      contentType,
      contentLength: content.length,
      modelName,
      hasExistingMetadata: !!existingMetadata,
    };

    return trackOperation(
      'llm_process_content',
      () => this.withRetries(content, contentType, existingMetadata, logContext),
      logContext
    );
  }

  /**
   * Get the AI model name from environment config or use default
   */
  private getModelName() {
    // Type assertion for accessing potentially undefined env vars
    const env = this.env as any;
    const configuredModel = env.AI_MODEL_NAME;
    const validModels = Object.keys(LlmService.MODEL_TOKEN_LIMITS);

    // If model is configured and valid, use it
    if (configuredModel && validModels.includes(configuredModel)) {
      return configuredModel as keyof AiModels;
    }

    return LlmService.DEFAULT_MODEL_NAME;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async withRetries(
    content: string,
    contentType: string,
    existingMetadata: { title?: string; summary?: string; tags?: string[] } | undefined,
    ctx: Record<string, unknown>
  ) {
    const schema = getSchemaForContentType(contentType);
    const instructions = getSchemaInstructions(contentType);
    const modelName = this.getModelName();

    // Build the prompt with existing metadata if available
    let promptContent = '';

    if (existingMetadata) {
      if (existingMetadata.title) {
        promptContent += `EXISTING TITLE: ${existingMetadata.title}\n\n`;
      }

      if (existingMetadata.summary) {
        promptContent += `EXISTING SUMMARY: ${existingMetadata.summary}\n\n`;
      }

      if (existingMetadata.tags && existingMetadata.tags.length > 0) {
        promptContent += `EXISTING TAGS: ${existingMetadata.tags.join(', ')}\n\n`;
      }
    }

    promptContent += `${contentType.toUpperCase()} CONTENT:\n${this.truncateContent(content, modelName as keyof AiModels)}`;

    const prompt = `${instructions}\n\n${promptContent}`;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= LlmService.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const raw = await this.callLlm(prompt, modelName as keyof AiModels);
        if (!raw) {
          throw new LLMProcessingError('Empty response from LLM', { requestId: ctx.requestId });
        }

        // Handle different response formats with safer type handling
        let responseText = '';
        if (typeof raw === 'string') {
          responseText = raw;
        } else if (raw && typeof raw === 'object') {
          // Handle both response and response.text patterns seen in AI APIs
          responseText = (raw as any).response ||
            (raw as any).text ||
            (raw as any).completion ||
            '';
        }

        if (!responseText) {
          throw new LLMProcessingError('Empty response text from LLM', { requestId: ctx.requestId });
        }

        const parsed = this.parseStructuredResponse(responseText, schema, ctx.requestId as string);

        this.logger.info({
          ...ctx,
          attempt: attempt + 1,
          responseLength: responseText.length
        }, 'LLM processing successful');

        return { ...parsed, processingVersion: 3, modelUsed: modelName };
      } catch (error) {
        lastError = error;

        // decide whether to retry or fallback
        if (attempt < LlmService.MAX_RETRY_ATTEMPTS) {
          await this.backoff(attempt);
          continue;
        }
        // final failure
        throw this.wrapError(error, `All LLM processing attempts failed for ${contentType}`, { ...ctx, attemptsMade: attempt + 1 });
      }
    }

    // should never reach here
    throw this.wrapError(lastError, 'Exhausted attempts', ctx);
  }

  private async callLlm(prompt: string, modelName: keyof AiModels) {
    const raw = await this.env.AI.run(modelName, {
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });
    if (raw instanceof ReadableStream) throw new LLMProcessingError('Unexpected streaming response');
    return raw;
  }

  private parseStructuredResponse(response: string, schema: any, requestId: string) {
    try {
      let jsonContent = response || '';
      const match = jsonContent.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match?.[1]) jsonContent = match[1];

      const data = JSON.parse(jsonContent);
      return schema.parse(data);
    } catch (err) {
      throw new LLMProcessingError('Failed to parse structured response', { requestId, response });
    }
  }


  private backoff(attempt: number) {
    const backoffMs = Math.pow(2, attempt) * 100;
    this.logger.warn({ attempt: attempt + 1, backoffMs }, 'LLM attempt failed, backing off');
    return new Promise(res => setTimeout(res, backoffMs));
  }

  private wrapError(err: unknown, msg: string, ctx: Record<string, unknown>) {
    const domeErr = toDomeError(err, msg, ctx);
    logError(domeErr, msg);
    return domeErr;
  }

  private truncateContent(content: string, modelName: keyof AiModels) {
    // Get the token limit for the specified model, or use a default limit
    // Type assertion for accessing potentially undefined env vars
    const env = this.env as any;
    const configLimitStr = env.AI_TOKEN_LIMIT;
    const configLimit = configLimitStr ? parseInt(configLimitStr, 10) : null;
    const modelLimit = LlmService.MODEL_TOKEN_LIMITS[modelName] || 8000;
    const maxLength = configLimit && !isNaN(configLimit) ? configLimit : modelLimit;

    if (content.length <= maxLength) return content;
    this.logger.debug({
      originalLength: content.length,
      truncatedLength: maxLength,
      modelName,
      customLimit: !!configLimit
    }, 'Truncating content');
    return content.substring(0, maxLength) + '... [content truncated]';
  }
}

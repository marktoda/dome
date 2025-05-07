import { getLogger, logError, trackOperation } from '../utils/logging';
import { toDomeError, LLMProcessingError, assertValid } from '../utils/errors';
import { getSchemaForContentType, getSchemaInstructions } from '../schemas';
import {
  CLOUDFLARE_MODELS,
  CLOUDFLARE_MODELS_ARRAY,
  ModelRegistry,
  truncateToTokenLimit,
  countTokens,
  BaseModelConfig,
} from '@dome/common';

const DEFAULT_MODEL = CLOUDFLARE_MODELS.GEMMA_3;
const REGISTRY = new ModelRegistry(CLOUDFLARE_MODELS_ARRAY);
REGISTRY.setDefaultModel(DEFAULT_MODEL.id);

/** Factory */
export function createLlmService(env: Env): LlmService {
  return new LlmService(env);
}

/**
 * LLM Service – flat control‑flow, minimal nested try/catch
 */
export class LlmService {
  private static readonly MAX_RETRY_ATTEMPTS = 2;

  private readonly logger = getLogger().child({ component: 'LlmService' });

  constructor(private readonly env: Env) {
    // Note: LLM configuration is now initialized automatically by the common package
  }

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
    const modelConfig = this.getModelConfig();

    const logContext = {
      requestId,
      contentType,
      contentLength: content.length,
      modelName: modelConfig.id,
      hasExistingMetadata: !!existingMetadata,
    };

    return trackOperation(
      'llm_process_content',
      () => this.withRetries(content, contentType, existingMetadata, logContext),
      logContext
    );
  }

  /**
   * Get the AI model configuration from environment config or use default
   */
  private getModelConfig(): BaseModelConfig {
    // Type assertion for accessing potentially undefined env vars
    const env = this.env as any;
    const configuredModelId = env.AI_MODEL_NAME;
    return REGISTRY.getModel(configuredModelId);
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
    const modelConfig = this.getModelConfig();
    const env = this.env as any; // For accessing potential env vars (declared once here)

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

    // Get token limit from model config or environment override
    // const env = this.env as any; // Removed: env is already declared above
    const configLimitStr = env.AI_TOKEN_LIMIT;
    const configLimit = configLimitStr ? parseInt(configLimitStr, 10) : null;
    const modelLimit = modelConfig.maxContextTokens;
    const tokenLimit = configLimit && !isNaN(configLimit) ? configLimit : modelLimit;

    // Truncate content if needed
    const truncatedContent = this.truncateContent(content, tokenLimit);
    promptContent += `${contentType.toUpperCase()} CONTENT:\n${truncatedContent}`;

    const prompt = `${instructions}\n\n${promptContent}`;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= LlmService.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        // Determine desired output tokens: use env override or model's default
        const configuredMaxOutputTokens = env.AI_MAX_OUTPUT_TOKENS ? parseInt(env.AI_MAX_OUTPUT_TOKENS, 10) : null;
        const desiredOutputTokens =
          (configuredMaxOutputTokens && !isNaN(configuredMaxOutputTokens))
          ? configuredMaxOutputTokens
          : modelConfig.defaultMaxTokens;

        const raw = await this.callLlm(prompt, modelConfig.id, desiredOutputTokens);
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

        return { ...parsed, processingVersion: 3, modelUsed: modelConfig.id };
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

  private async callLlm(prompt: string, modelName: string, maxTokens?: number) {
    // Type assertion to satisfy the Cloudflare Workers AI type constraints
    const modelNameAsKey = modelName as keyof AiModels;
    
    const aiRunParams: { messages: { role: string; content: string }[]; stream: boolean; max_tokens?: number } = {
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    };

    if (maxTokens && maxTokens > 0) {
      aiRunParams.max_tokens = maxTokens;
    }

    const raw = await this.env.AI.run(modelNameAsKey, aiRunParams);
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
      let message = 'Failed to parse structured response';
      const trimmedResponse = response.trim();
      if (trimmedResponse.length > 0) {
        const lastChar = trimmedResponse[trimmedResponse.length - 1];
        // Check if the response ends prematurely (e.g. not with a '}' or ']' for an object/array, or unclosed string)
        const looksTruncated =
          (trimmedResponse.startsWith('{') && !trimmedResponse.endsWith('}')) ||
          (trimmedResponse.startsWith('[') && !trimmedResponse.endsWith(']')) ||
          (lastChar !== '}' && lastChar !== ']' && lastChar !== '"' && (trimmedResponse.includes('{') || trimmedResponse.includes('[')));

        if (looksTruncated) {
           message = 'Failed to parse structured response, suspected truncation from LLM. Raw response may be incomplete.';
        }
      }
      throw new LLMProcessingError(message, { requestId, response });
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

  /**
   * Truncate content to fit within token limit
   * @param content Content to truncate
   * @param tokenLimit Maximum tokens allowed
   * @returns Truncated content
   */
  private truncateContent(content: string, tokenLimit: number): string {
    if (!content) return '';

    // Log truncation details
    const tokenCount = countTokens(content);
    if (tokenCount > tokenLimit) {
      this.logger.debug({
        originalTokens: tokenCount,
        tokenLimit,
        customLimit: (this.env as any).AI_TOKEN_LIMIT ? true : false
      }, 'Truncating content');
    }

    // Use the common package's truncation utility
    return truncateToTokenLimit(content, tokenLimit, (text) => countTokens(text));
  }
}

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
  private static readonly MODEL_NAME = '@cf/google/gemma-7b-it-lora';
  private static readonly MAX_RETRY_ATTEMPTS = 2;

  private readonly logger = getLogger().child({ component: 'LlmService' });

  constructor(private readonly env: Env) { }

  /** Entry point */
  async processContent(content: string, contentType: string) {
    assertValid(!!content, 'Content is required for LLM processing', { contentType });
    assertValid(!!contentType, 'Content type is required for LLM processing');

    const requestId = crypto.randomUUID();
    const logContext = {
      requestId,
      contentType,
      contentLength: content.length,
      modelName: LlmService.MODEL_NAME,
    };

    return trackOperation('llm_process_content', () => this.withRetries(content, contentType, logContext), logContext);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async withRetries(content: string, contentType: string, ctx: Record<string, unknown>) {
    const schema = getSchemaForContentType(contentType);
    const instructions = getSchemaInstructions(contentType);
    const prompt = `${instructions}\n\n${contentType.toUpperCase()} CONTENT:\n${this.truncateContent(content, 8000)}`;

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= LlmService.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const raw = await this.callLlm(prompt);
        if (!raw || !raw.response) {
          throw new LLMProcessingError('Empty response from LLM', { requestId: ctx.requestId });
        }
        const parsed = this.parseStructuredResponse(raw.response, schema, ctx.requestId as string);

        this.logger.info({ ...ctx, attempt: attempt + 1, responseLength: raw.response?.length ?? 0 }, 'LLM processing successful');

        return { ...parsed, processingVersion: 2, modelUsed: LlmService.MODEL_NAME };
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

  private async callLlm(prompt: string) {
    const raw = await this.env.AI.run(LlmService.MODEL_NAME, {
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

  private truncateContent(content: string, maxLength: number) {
    if (content.length <= maxLength) return content;
    this.logger.debug({ originalLength: content.length, truncatedLength: maxLength }, 'Truncating content');
    return content.substring(0, maxLength) + '... [content truncated]';
  }
}

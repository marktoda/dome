import { getLogger } from './logging';

export interface RetryConfig {
  attempts: number;
  delayMs: number;
  operationName?: string; // Optional: for logging
}

/**
 * Executes an async function with retry logic.
 *
 * @param fn The async function to execute.
 * @param config Configuration for retry attempts and delay.
 * @param context Optional context for logging.
 * @returns A promise that resolves with the result of the function if successful.
 * @throws The last error encountered if all attempts fail.
 */
export async function retryAsync<T>(
  fn: (currentAttempt: number) => Promise<T>,
  config: RetryConfig,
  context: Record<string, any> = {},
): Promise<T> {
  let lastError: Error | null = null;
  const logger = getLogger();
  const operationName = config.operationName || 'unnamed_operation';

  for (let attempt = 1; attempt <= config.attempts; attempt++) {
    try {
      logger.debug(
        { ...context, operation: operationName, attempt, maxAttempts: config.attempts },
        `Attempt ${attempt} of ${config.attempts} for ${operationName}`,
      );
      return await fn(attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        {
          ...context,
          operation: operationName,
          attempt,
          maxAttempts: config.attempts,
          error: lastError.message,
          stack: lastError.stack,
        },
        `Attempt ${attempt} for ${operationName} failed. Retries left: ${config.attempts - attempt}`,
      );

      if (attempt < config.attempts) {
        if (config.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, config.delayMs * attempt)); // Linear backoff, or use fixed delay
        }
      }
    }
  }
  logger.error(
    { ...context, operation: operationName, attempts: config.attempts, error: lastError?.message },
    `${operationName} failed after ${config.attempts} attempts.`,
  );
  throw lastError;
}
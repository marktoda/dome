import { als, baseLogger } from './runtime';
import type { Logger } from 'pino';

/**
 * Get the current logger from the async local storage or fall back to the base logger
 */
export function getLogger(): Logger {
  return (als.getStore()?.get('logger') as Logger) ?? baseLogger;
}

/**
 * Helper function to properly extract error information for logging
 * @param error The error object to extract information from
 * @returns An object with error and errorMessage properties
 */
export function extractErrorInfo(error: unknown): { error: unknown; errorMessage: string } {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { error, errorMessage };
}

/**
 * Enhanced error logging that properly extracts and includes error messages
 * @param logger The logger instance
 * @param error The error object
 * @param message The log message
 * @param additionalContext Additional context to include in the log
 */
export function logError(
  logger: Logger,
  error: unknown,
  message: string,
  additionalContext: Record<string, unknown> = {},
): void {
  const { errorMessage } = extractErrorInfo(error);
  getLogger().error({ error, errorMessage, ...additionalContext }, message);
}

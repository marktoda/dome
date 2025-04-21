import { getLogger, withLogger, InitOptions } from '@dome/logging';
import { ulid } from 'ulid';

/**
 * Initialize the logger with environment-specific configuration
 * @param env Environment variables
 */
export function initLogger(env: { LOG_LEVEL: string; ENVIRONMENT: string; VERSION: string }): void {
  // Initialize the logger with default context
  withLogger(
    {
      service: 'github-ingestor',
      version: env.VERSION || 'unknown',
      environment: env.ENVIRONMENT || 'development',
    },
    () => {
      getLogger().info('Logger initialized');
    },
  );
}

/**
 * Re-export the logger from @dome/logging
 */
export const logger = (): ReturnType<typeof getLogger> => getLogger();

/**
 * Create a request-scoped logger with a request ID
 * @param requestId Optional request ID (generated if not provided)
 * @returns Logger with request ID
 */
export function createRequestLogger(requestId?: string): ReturnType<typeof getLogger> {
  const rid = requestId || ulid();
  return getLogger().child({ request_id: rid });
}

/**
 * Create a repository-scoped logger
 * @param owner Repository owner
 * @param repo Repository name
 * @param userId User ID (optional)
 * @returns Logger with repository context
 */
export function createRepoLogger(
  owner: string,
  repo: string,
  userId?: string,
): ReturnType<typeof getLogger> {
  const context: Record<string, any> = { owner, repo };
  if (userId) context.user_id = userId;
  return getLogger().child(context);
}

/**
 * Log an error with context
 * @param error Error object
 * @param message Optional message
 * @param context Additional context
 */
export function logError(error: Error, message?: string, context: Record<string, any> = {}) {
  getLogger().error(
    {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      ...context,
    },
    message || 'An error occurred',
  );
}

import { getLogger as getDomeLogger, metrics } from '@dome/logging';

/**
 * Get a logger instance with the ai-processor service name
 */
export function getLogger(): any {
  return getDomeLogger().child({ service: 'ai-processor' });
}

/**
 * Initialize logging with the environment
 * @param env Environment variables
 */
export function initLogging(env: { LOG_LEVEL?: string; ENVIRONMENT?: string; VERSION?: string }) {
  // The @dome/logging package handles configuration internally
  // We just need to add some context for our service

  getLogger().info(
    {
      level: env.LOG_LEVEL || 'info',
      environment: env.ENVIRONMENT || 'dev',
      version: env.VERSION || '0.1.0',
    },
    'Initialized logging for ai-processor service',
  );
}

/**
 * Export metrics from @dome/logging
 */
export { metrics };

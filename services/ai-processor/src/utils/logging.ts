import {
  getLogger as getDomeLogger,
  metrics,
  logError as domeLogError,
  trackOperation as domeTrackOperation,
  logOperationStart,
  logOperationSuccess,
  logOperationFailure,
  createServiceMetrics,
} from '@dome/common';
import { toDomeError } from '@dome/errors';

// Create service-specific metrics
export const aiProcessorMetrics = createServiceMetrics('ai-processor');

/**
 * Get a logger instance with the ai-processor service name
 */
export function getLogger(): any {
  return getDomeLogger().child({ service: 'ai-processor' });
}

/**
 * Specialized error logging with consistent context
 * @param error Error to log
 * @param message Error message
 * @param context Additional context information
 */
export function logError(error: unknown, message: string, context: Record<string, any> = {}): void {
  const domeError = toDomeError(error, message, {
    service: 'ai-processor',
    ...context,
  });

  domeLogError(domeError, message, context);

  // Track error metrics for monitoring
  aiProcessorMetrics.trackOperation('error', false, {
    errorType: domeError.code,
    operation: context.operation || 'unknown',
  });
}

/**
 * Track an operation with standardized logging
 * @param operationName Name of the operation
 * @param fn Function to execute and track
 * @param context Additional context to include in logs
 * @returns Result of the operation
 */
export async function trackOperation<T>(
  operationName: string,
  fn: () => Promise<T>,
  context: Record<string, any> = {},
): Promise<T> {
  return domeTrackOperation(operationName, fn, { service: 'ai-processor', ...context });
}

/**
 * Initialize logging with the environment
 * @param env Environment variables
 */
export function initLogging(env: { LOG_LEVEL?: string; ENVIRONMENT?: string; VERSION?: string }) {
  // The @dome/common package handles configuration internally
  // We just need to add some context for our service
  const environment = env.ENVIRONMENT || 'dev';
  const version = env.VERSION || '0.1.0';

  getLogger().info(
    {
      level: env.LOG_LEVEL || 'info',
      environment,
      version,
      service: 'ai-processor',
      initTimestamp: new Date().toISOString(),
    },
    'Initialized logging for ai-processor service',
  );

  // Set up initial metrics
  aiProcessorMetrics.gauge('service.initialized', 1, {
    environment,
    version,
  });
}

/**
 * Sanitize sensitive data for logging
 * @param data Object containing possible sensitive data
 * @returns Sanitized copy with sensitive fields redacted
 */
export function sanitizeForLogging<T extends Record<string, any>>(data: T): T {
  const sensitiveFields = ['password', 'token', 'secret', 'key', 'apiKey', 'auth'];
  const sanitized = { ...data };

  for (const field of Object.keys(sanitized)) {
    if (sensitiveFields.some(sensitive => field.toLowerCase().includes(sensitive))) {
      sanitized[field as keyof T] = '[REDACTED]' as any;
    } else if (
      typeof sanitized[field as keyof T] === 'object' &&
      sanitized[field as keyof T] !== null
    ) {
      sanitized[field as keyof T] = sanitizeForLogging(sanitized[field as keyof T]) as any;
    }
  }

  return sanitized;
}

/**
 * Export metrics and logging utilities from @dome/common
 */
export { metrics, logOperationStart, logOperationSuccess, logOperationFailure };

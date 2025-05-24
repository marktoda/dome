import {
  getLogger as getDomeLogger,
  logError as domeLogError,
  trackOperation as domeTrackOperation,
  logOperationStart,
  logOperationSuccess,
  logOperationFailure,
  createServiceMetrics,
} from '@dome/common';
import { toDomeError } from './errors';

// Create service-specific metrics
export const chatMetrics = createServiceMetrics('chat');

/**
 * Get a logger instance with the chat service name
 */
export function getLogger(): any {
  return getDomeLogger().child({ service: 'chat' });
}

/**
 * Specialized error logging with consistent context
 * @param error Error to log
 * @param message Error message
 * @param context Additional context information
 */
export function logError(error: unknown, message: string, context: Record<string, any> = {}): void {
  const domeError = toDomeError(error, message, {
    service: 'chat',
    ...context,
  });

  domeLogError(domeError, message, context);

  // Track error metrics for monitoring
  chatMetrics.trackOperation('error', false, {
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
  return domeTrackOperation(operationName, fn, { service: 'chat', ...context });
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
 * Export logging utilities from @dome/common (excluding generic metrics)
 */
export { logOperationStart, logOperationSuccess, logOperationFailure };
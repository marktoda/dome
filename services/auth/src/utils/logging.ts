import {
  getLogger as getDomeLogger,
  metrics,
  logError as domeLogError,
  trackOperation as domeTrackOperation,
  logOperationStart,
  logOperationSuccess,
  logOperationFailure,
  createServiceMetrics
} from '@dome/logging';
import { AuthError, AuthErrorType } from './errors';

// Create service-specific metrics
export const authMetrics = createServiceMetrics('auth');

/**
 * Get a logger instance with the auth service name
 */
export function getLogger(): any {
  return getDomeLogger().child({ service: 'auth' });
}

/**
 * Specialized error logging with consistent context
 * @param error Error to log
 * @param message Error message
 * @param context Additional context information
 */
export function logError(error: unknown, message: string, context: Record<string, any> = {}): void {
  // Convert to AuthError if it's not already
  const authError = error instanceof AuthError
    ? error
    : new AuthError(
        error instanceof Error ? error.message : String(error),
        AuthErrorType.INTERNAL_ERROR,
        500
      );
  
  domeLogError(authError, message, {
    service: 'auth',
    ...context
  });
  
  // Track error metrics for monitoring
  authMetrics.trackOperation('error', false, {
    errorType: authError.type,
    operation: context.operation || 'unknown'
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
  context: Record<string, any> = {}
): Promise<T> {
  return domeTrackOperation(
    operationName,
    fn,
    { service: 'auth', ...context }
  );
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
    } else if (typeof sanitized[field as keyof T] === 'object' && sanitized[field as keyof T] !== null) {
      sanitized[field as keyof T] = sanitizeForLogging(sanitized[field as keyof T]) as any;
    }
  }
  
  return sanitized;
}

/**
 * Export metrics and logging utilities from @dome/logging
 */
export {
  metrics,
  logOperationStart,
  logOperationSuccess,
  logOperationFailure
};
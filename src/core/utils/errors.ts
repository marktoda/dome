/**
 * Centralized error handling utilities for the Dome application.
 * Provides consistent error types and handling patterns.
 */

import logger from './logger.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Base error class for all Dome-specific errors
 */
export class DomeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly cause?: Error;
  public readonly context?: Record<string, any>;

  constructor(
    message: string,
    options?: {
      code?: string;
      statusCode?: number;
      cause?: Error;
      context?: Record<string, any>;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options?.code || 'DOME_ERROR';
    this.statusCode = options?.statusCode || 500;
    this.cause = options?.cause;
    this.context = options?.context;
    
    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert error to JSON-serializable object
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
      stack: this.stack,
    };
  }
}

/**
 * Error thrown when a required configuration value is missing or invalid
 */
export class ConfigurationError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'CONFIG_ERROR', statusCode: 500 });
  }
}

/**
 * Error thrown when a file operation fails
 */
export class FileSystemError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'FS_ERROR', statusCode: 500 });
  }
}

/**
 * Error thrown when a database operation fails
 */
export class DatabaseError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'DB_ERROR', statusCode: 500 });
  }
}

/**
 * Error thrown when an AI/LLM operation fails
 */
export class AIError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'AI_ERROR', statusCode: 503 });
  }
}

/**
 * Error thrown when input validation fails
 */
export class ValidationError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'VALIDATION_ERROR', statusCode: 400 });
  }
}

/**
 * Error thrown when a requested resource is not found
 */
export class NotFoundError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'NOT_FOUND', statusCode: 404 });
  }
}

/**
 * Error thrown when an operation times out
 */
export class TimeoutError extends DomeError {
  constructor(message: string, options?: Omit<ConstructorParameters<typeof DomeError>[1], 'code'>) {
    super(message, { ...options, code: 'TIMEOUT', statusCode: 408 });
  }
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Type guard to check if error is a DomeError
 */
export function isDomeError(error: unknown): error is DomeError {
  return error instanceof DomeError;
}

/**
 * Type guard to check if value is an Error
 */
export function isError(value: unknown): value is Error {
  return value instanceof Error;
}

/**
 * Convert unknown error to Error object
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  
  if (typeof error === 'string') {
    return new Error(error);
  }
  
  if (typeof error === 'object' && error !== null) {
    const obj = error as any;
    const message = obj.message || obj.error || JSON.stringify(error);
    return new Error(message);
  }
  
  return new Error(String(error));
}

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  
  if (typeof error === 'string') {
    return error;
  }
  
  if (typeof error === 'object' && error !== null) {
    const obj = error as any;
    return obj.message || obj.error || JSON.stringify(error);
  }
  
  return String(error);
}

/**
 * Log error with appropriate context
 */
export function logError(
  error: unknown,
  context?: string,
  additionalData?: Record<string, any>
): void {
  const err = toError(error);
  const errorData: Record<string, any> = {
    ...additionalData,
    context,
    code: (err as any).code,
    stack: err.stack,
  };
  
  if (isDomeError(err)) {
    errorData.domeContext = err.context;
  }
  
  logger.error(errorData, err.message);
}

/**
 * Wrap an async function with standardized error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options?: {
    context?: string;
    fallback?: any;
    rethrow?: boolean;
  }
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      logError(error, options?.context);
      
      if (options?.rethrow !== false) {
        throw error;
      }
      
      return options?.fallback;
    }
  }) as T;
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: {
    maxAttempts?: number;
    delay?: number;
    backoff?: number;
    onError?: (error: unknown, attempt: number) => void;
  }
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delay = options?.delay ?? 1000;
  const backoff = options?.backoff ?? 2;
  
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (options?.onError) {
        options.onError(error, attempt);
      }
      
      if (attempt < maxAttempts) {
        const waitTime = delay * Math.pow(backoff, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError;
}

/**
 * Create a timeout promise that rejects after specified time
 */
export function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `Operation timed out after ${ms}ms`
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new TimeoutError(message)), ms)
    ),
  ]);
}

/**
 * Ensure a value is not null or undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message = 'Value is null or undefined'
): asserts value is T {
  if (value === null || value === undefined) {
    throw new ValidationError(message);
  }
}

/**
 * Create an error handler for Express-like middleware
 */
export function createErrorHandler(
  defaultMessage = 'An unexpected error occurred'
) {
  return (error: unknown, context?: string) => {
    const err = toError(error);
    
    if (isDomeError(err)) {
      return {
        success: false,
        error: {
          message: err.message,
          code: err.code,
          context: err.context,
        },
      };
    }
    
    logError(err, context);
    
    return {
      success: false,
      error: {
        message: defaultMessage,
        code: 'INTERNAL_ERROR',
      },
    };
  };
}

// ============================================================================
// Error Aggregation
// ============================================================================

/**
 * Aggregate multiple errors into a single error
 */
export class AggregateError extends DomeError {
  public readonly errors: Error[];
  
  constructor(errors: Error[], message?: string) {
    const errorMessages = errors.map(e => e.message).join('; ');
    super(message || `Multiple errors occurred: ${errorMessages}`, {
      code: 'AGGREGATE_ERROR',
    });
    this.errors = errors;
  }
}

/**
 * Collect errors from multiple operations
 */
export class ErrorCollector {
  private errors: Error[] = [];
  
  add(error: unknown): void {
    this.errors.push(toError(error));
  }
  
  hasErrors(): boolean {
    return this.errors.length > 0;
  }
  
  getErrors(): Error[] {
    return [...this.errors];
  }
  
  throwIfAny(message?: string): void {
    if (this.hasErrors()) {
      throw new AggregateError(this.errors, message);
    }
  }
  
  clear(): void {
    this.errors = [];
  }
}
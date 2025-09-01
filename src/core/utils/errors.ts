/**
 * Simplified error handling utilities for the Dome application.
 */

import logger from './logger.js';

/**
 * Create a Dome error with code and status
 */
export function createError(
  message: string,
  code = 'DOME_ERROR',
  statusCode = 500
): Error {
  const error = new Error(message);
  (error as any).code = code;
  (error as any).statusCode = statusCode;
  return error;
}

/**
 * Convert unknown error to Error object
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(String(error));
}

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Log error with context
 */
export function logError(error: unknown, context?: string): void {
  const err = toError(error);
  logger.error({ context, code: (err as any).code }, err.message);
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  
  throw lastError;
}

/**
 * Add timeout to a promise
 */
export function timeout<T>(
  promise: Promise<T>,
  ms: number,
  message = `Operation timed out after ${ms}ms`
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}
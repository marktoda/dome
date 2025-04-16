import { Context } from 'hono';
import { ApiResponse } from '@communicator/common';

/**
 * Extended error interface with additional properties
 */
export interface ExtendedError {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, any>;
}

/**
 * Response result interface
 */
export interface ResponseResult {
  body: ApiResponse;
  status: number;
}

/**
 * Creates a success response
 * @param data Response data
 * @param status HTTP status code (default: 200)
 * @returns API response object
 */
export function createSuccessResponse(data: Record<string, any>, status: number = 200): ResponseResult {
  console.info('Creating success response', { status });

  return {
    body: {
      success: true,
      data
    },
    status
  };
}

/**
 * Creates an error response
 * @param error Error details
 * @param status HTTP status code (default: 500)
 * @returns API response object
 */
export function createErrorResponse(error: Omit<ExtendedError, 'requestId'>, status: number = 500): ResponseResult {
  const requestId = getRequestId();
  const extendedError: ExtendedError = {
    ...error,
    requestId
  };

  console.error('Creating error response', { error: extendedError, status });

  return {
    body: {
      success: false,
      error: extendedError
    },
    status
  };
}

/**
 * Creates a validation error response (400 Bad Request)
 * @param message Error message
 * @param details Additional error details
 * @returns API response object
 */
export function createValidationErrorResponse(message: string, details?: Record<string, any>): ResponseResult {
  return createErrorResponse({
    code: 'VALIDATION_ERROR',
    message,
    ...(details && { details })
  }, 400);
}

/**
 * Creates a server error response (500 Internal Server Error)
 * @param message Error message
 * @param details Additional error details
 * @returns API response object
 */
export function createServerErrorResponse(message: string, details?: Record<string, any>): ResponseResult {
  return createErrorResponse({
    code: 'SERVER_ERROR',
    message,
    ...(details && { details })
  }, 500);
}

/**
 * Creates a queue error response (500 Internal Server Error)
 * @param message Error message
 * @param details Additional error details
 * @returns API response object
 */
export function createQueueErrorResponse(message: string, details?: Record<string, any>): ResponseResult {
  return createErrorResponse({
    code: 'QUEUE_ERROR',
    message,
    ...(details && { details })
  }, 500);
}

/**
 * Sends an error response
 * @param c Hono context
 * @param error Error details
 * @param status HTTP status code (default: 500)
 * @returns Hono response
 */
export function sendErrorResponse(c: Context, error: Omit<ExtendedError, 'requestId'>, status: number = 500): Response {
  const { body, status: responseStatus } = createErrorResponse(error, status);
  return c.json(body, responseStatus);
}

/**
 * Sends a validation error response (400 Bad Request)
 * @param c Hono context
 * @param message Error message
 * @param details Additional error details
 * @returns Hono response
 */
export function sendValidationErrorResponse(c: Context, message: string, details?: Record<string, any>): Response {
  const { body, status } = createValidationErrorResponse(message, details);
  return c.json(body, status);
}

/**
 * Sends a server error response (500 Internal Server Error)
 * @param c Hono context
 * @param message Error message
 * @param details Additional error details
 * @returns Hono response
 */
export function sendServerErrorResponse(c: Context, message: string, details?: Record<string, any>): Response {
  const { body, status } = createServerErrorResponse(message, details);
  return c.json(body, status);
}

/**
 * Sends a queue error response (500 Internal Server Error)
 * @param c Hono context
 * @param message Error message
 * @param details Additional error details
 * @returns Hono response
 */
export function sendQueueErrorResponse(c: Context, message: string, details?: Record<string, any>): Response {
  const { body, status } = createQueueErrorResponse(message, details);
  return c.json(body, status);
}

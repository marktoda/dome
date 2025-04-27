import { Context } from 'hono';

/**
 * Standard response structure
 */
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Create a successful response
 * @param c Hono context
 * @param data Response data
 * @param status HTTP status code (default: 200)
 * @returns JSON response
 */
export function successResponse<T>(c: Context, data: T, status = 200): Response {
  const response: ApiResponse<T> = {
    success: true,
    data,
  };
  return c.json(response, status as any);
}

/**
 * Create an error response
 * @param c Hono context
 * @param code Error code
 * @param message Error message
 * @param status HTTP status code (default: 400)
 * @returns JSON response
 */
export function errorResponse(c: Context, code: string, message: string, status = 400): Response {
  const response: ApiResponse<never> = {
    success: false,
    error: {
      code,
      message,
    },
  };
  return c.json(response, status as any);
}

/**
 * Create an unauthorized response
 * @param c Hono context
 * @param message Error message (default: 'Unauthorized')
 * @returns JSON response
 */
export function unauthorizedResponse(c: Context, message = 'Unauthorized'): Response {
  return errorResponse(c, 'UNAUTHORIZED', message, 401);
}

/**
 * Create a validation error response
 * @param c Hono context
 * @param error Error object or message
 * @returns JSON response
 */
export function validationErrorResponse(c: Context, error: Error | string): Response {
  const message = error instanceof Error ? error.message : error;
  return errorResponse(c, 'INVALID_REQUEST', message, 400);
}

/**
 * Create an internal server error response
 * @param c Hono context
 * @param message Error message (default: 'An unexpected error occurred')
 * @returns JSON response
 */
export function internalErrorResponse(
  c: Context,
  message = 'An unexpected error occurred',
): Response {
  return errorResponse(c, 'INTERNAL_ERROR', message, 500);
}

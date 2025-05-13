import type { Context, MiddlewareHandler, Next } from 'hono';
import type { ApiResponse } from '../types/index.js';

/**
 * Type for a response with status
 */
type ResponseWithStatus = {
  body: any;
  status: number;
};

/**
 * Response handler middleware for Hono
 *
 * This middleware allows controllers to return plain objects
 * which will be automatically wrapped in a standardized API response format.
 *
 * Controllers can return:
 * 1. A plain object: { message: "Success", count: 5 }
 *    This will be wrapped as: { success: true, data: { message: "Success", count: 5 } }
 *
 * 2. An object with status: { body: { message: "Created" }, status: 201 }
 *    This will be wrapped as: { success: true, data: { message: "Created" } } with 201 status
 *
 * 3. A Response object: Will be returned as-is
 */
export const responseHandlerMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  // Process the request through the rest of the middleware chain and route handlers
  const result: any = await next();

  // If the result is undefined, return it as-is
  if (result === undefined) {
    return result;
  }

  // If the result is already a Response, return it as-is
  if (result instanceof Response) {
    return result;
  }

  // Check if the result has a body and status property
  if (result && typeof result === 'object' && 'body' in result && 'status' in result) {
    const { body, status } = result as ResponseWithStatus;

    // If the body is already an ApiResponse, return it directly
    if (body && typeof body === 'object' && 'success' in body) {
      return c.json(body, status as any);
    }

    // Otherwise, wrap the body in a standardized success response
    const apiResponse: ApiResponse = {
      success: true,
      data: body,
    };

    // Debug: Response handler wrapping body with status
    return c.json(apiResponse, status as any);
  }

  // For plain objects, wrap them in a standardized success response
  const apiResponse: ApiResponse = {
    success: true,
    data: result,
  };

  // Debug: Response handler wrapping plain object
  return c.json(apiResponse);
};

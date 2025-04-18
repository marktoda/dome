import type { MiddlewareHandler } from 'hono';
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
export declare const responseHandlerMiddleware: MiddlewareHandler;

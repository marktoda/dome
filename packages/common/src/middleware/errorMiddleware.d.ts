import type { MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
/**
 * Error handling middleware for Hono
 * Catches errors and formats them into standardized responses
 *
 * @param formatZodError Optional function to format Zod validation errors
 * @returns Middleware handler
 */
export declare function createErrorMiddleware(
  formatZodError?: (error: ZodError) => any,
): MiddlewareHandler;

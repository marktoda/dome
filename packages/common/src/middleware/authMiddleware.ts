import type { Context, MiddlewareHandler, Next } from 'hono';
import { UnauthorizedError } from '../errors/ServiceError.js';

/**
 * Authentication middleware options
 */
export interface AuthOptions {
  /**
   * Header name for the API key
   * @default 'x-api-key'
   */
  headerName?: string;

  /**
   * Environment variable name for the API key
   * @default 'API_KEY'
   */
  envVarName?: string;

  /**
   * Whether to skip authentication in development mode
   * @default true
   */
  skipInDevelopment?: boolean;
}

/**
 * Creates an authentication middleware that validates API keys
 *
 * @param options Authentication options
 * @returns Middleware handler
 */
export function createAuthMiddleware(options?: AuthOptions): MiddlewareHandler {
  const {
    headerName = 'x-api-key',
    envVarName = 'API_KEY',
    skipInDevelopment = true,
  } = options || {};

  return async (c: Context, next: Next) => {
    // Get environment
    const environment = c.env?.ENVIRONMENT || 'development';

    // Skip authentication in development mode if configured
    if (skipInDevelopment && environment === 'development') {
      await next();
      return;
    }

    // Get API key from header
    const apiKey = c.req.header(headerName);

    // Check if API key is provided
    if (!apiKey) {
      throw new UnauthorizedError('API key is required');
    }

    // Get expected API key from environment
    const expectedApiKey = c.env?.[envVarName];

    // Check if API key is valid
    if (!expectedApiKey || apiKey !== expectedApiKey) {
      throw new UnauthorizedError('Invalid API key');
    }

    // Continue to next middleware
    await next();
  };
}

/**
 * Creates a simple authentication middleware for development
 * This is a placeholder that will be replaced with a proper authentication system in later stages
 *
 * @returns Middleware handler
 */
export function createSimpleAuthMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Get environment
    const environment = c.env?.ENVIRONMENT || 'development';

    // Skip authentication in development mode
    if (environment === 'development') {
      await next();
      return;
    }

    // Get API key from header
    const apiKey = c.req.header('x-api-key');

    // Check if API key is provided
    if (!apiKey) {
      throw new UnauthorizedError('API key is required');
    }

    // In a real implementation, we would validate the API key against a database
    // For now, we'll just check if it's not empty
    if (!apiKey.trim()) {
      throw new UnauthorizedError('Invalid API key');
    }

    // Continue to next middleware
    await next();
  };
}

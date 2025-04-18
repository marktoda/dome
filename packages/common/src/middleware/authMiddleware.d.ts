import type { MiddlewareHandler } from 'hono';
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
export declare function createAuthMiddleware(options?: AuthOptions): MiddlewareHandler;
/**
 * Creates a simple authentication middleware for development
 * This is a placeholder that will be replaced with a proper authentication system in later stages
 *
 * @returns Middleware handler
 */
export declare function createSimpleAuthMiddleware(): MiddlewareHandler;

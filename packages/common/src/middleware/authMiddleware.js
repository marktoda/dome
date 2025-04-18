import { UnauthorizedError } from '../errors/ServiceError';
/**
 * Creates an authentication middleware that validates API keys
 *
 * @param options Authentication options
 * @returns Middleware handler
 */
export function createAuthMiddleware(options) {
    const { headerName = 'x-api-key', envVarName = 'API_KEY', skipInDevelopment = true, } = options || {};
    return async (c, next) => {
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
export function createSimpleAuthMiddleware() {
    return async (c, next) => {
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
//# sourceMappingURL=authMiddleware.js.map
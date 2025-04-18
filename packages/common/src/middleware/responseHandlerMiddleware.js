import pino from 'pino';
// Create a logger instance
const logger = pino({ level: 'info' });
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
export const responseHandlerMiddleware = async (c, next) => {
    // Process the request through the rest of the middleware chain and route handlers
    const result = await next();
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
        const { body, status } = result;
        // If the body is already an ApiResponse, return it directly
        if (body && typeof body === 'object' && 'success' in body) {
            return c.json(body, status);
        }
        // Otherwise, wrap the body in a standardized success response
        const apiResponse = {
            success: true,
            data: body,
        };
        logger.debug('Response handler wrapping body with status');
        return c.json(apiResponse, status);
    }
    // For plain objects, wrap them in a standardized success response
    const apiResponse = {
        success: true,
        data: result,
    };
    logger.debug('Response handler wrapping plain object');
    return c.json(apiResponse);
};
//# sourceMappingURL=responseHandlerMiddleware.js.map
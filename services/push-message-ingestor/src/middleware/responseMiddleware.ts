import { Context, MiddlewareHandler, Next } from 'hono';
import { ApiResponse } from '@communicator/common';
import pino from 'pino';

// Create a logger instance
const logger = pino({ level: 'info' });

/**
 * Response middleware for Hono
 * Wraps successful responses in a standardized format
 *
 * This middleware allows controllers to return plain objects
 * instead of calling response.json(...) directly
 */
export const responseMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  // Continue with the request
  await next();
  
  // Get the response from the context
  const response = c.res;
  
  // If the response has already been set, don't modify it
  if (response && response.headers.get('content-type')?.includes('application/json')) {
    // The response is already set and is JSON, so we don't need to do anything
    return;
  }
  
  // Add a helper method to the context for wrapping responses
  c.set('wrapResponse', (data: any, status: number = 200) => {
    // If the data is already formatted as an ApiResponse, use it directly
    if (data && (data.success === true || data.success === false)) {
      return c.json(data, status);
    }
    
    // Otherwise, wrap the data in a standardized success response
    const apiResponse: ApiResponse = {
      success: true,
      data
    };
    
    logger.debug('Response middleware wrapping data in standard format');
    return c.json(apiResponse, status);
  });
};

/**
 * Type declaration for the wrapResponse method
 */
declare module 'hono' {
  interface ContextVariableMap {
    wrapResponse: (data: any, status?: number) => Response;
  }
}
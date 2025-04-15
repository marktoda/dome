import { Request, Response, NextFunction } from 'express';
import { ApiError, AppError, errorToResponse } from '../../utils/errors';
import { logError } from '../../utils/logger';
import { SERVER } from '../../config';

/**
 * Global error handling middleware
 * Catches all errors thrown in the application and formats them as API responses
 */
export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Log the error with request context
  logError(err, req);

  // Set default status code
  let statusCode = 500;

  // If it's an ApiError or AppError, use its status code
  if (err instanceof ApiError || err instanceof AppError) {
    statusCode = err.statusCode;
  }

  // Convert error to response format
  const response = errorToResponse(err, !SERVER.IS_PRODUCTION);

  // Send response
  res.status(statusCode).json(response);
};

/**
 * Async handler wrapper
 * Catches errors in async route handlers and passes them to the error handler
 * 
 * @example
 * router.get('/users', asyncHandler(async (req, res) => {
 *   const users = await userService.getAll();
 *   res.json(users);
 * }));
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction): Promise<any> => {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Not found handler
 * Handles 404 errors for routes that don't exist
 * Should be placed after all other routes
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  const error = new ApiError(
    `Route not found: ${req.method} ${req.originalUrl}`,
    404,
    'NOT_FOUND'
  );
  next(error);
};

/**
 * Validation error handler
 * Converts express-validator validation errors to a standardized format
 */
export const validationErrorHandler = (req: Request, res: Response, next: NextFunction): void => {
  // This middleware is meant to be used after express-validator's validationResult
  const validationResult = (req as any).validationResult;
  
  if (validationResult && typeof validationResult === 'function') {
    const errors = validationResult(req);
    
    if (!errors.isEmpty()) {
      const error = new ApiError(
        'Validation failed',
        400,
        'VALIDATION_ERROR',
        { errors: errors.array() }
      );
      return next(error);
    }
  }
  
  next();
};
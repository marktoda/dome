import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logRequest, logResponse, getRequestId } from '../../utils/logger';

/**
 * Symbol used to store the start time on the request object
 */
const startTimeSymbol = Symbol('startTime');

/**
 * Middleware to log incoming requests and outgoing responses
 * Attaches a unique request ID to each request for tracking
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  // Generate and attach request ID if not already present
  const requestId = getRequestId(req);

  // Store the start time for calculating response time
  (req as any)[startTimeSymbol] = Date.now();

  // Log the incoming request (excluding sensitive data)
  const sanitizedQuery = sanitizeObject(req.query);
  const sanitizedBody = sanitizeObject(req.body);

  logRequest(req, 'Incoming request', {
    query: sanitizedQuery,
    body: sanitizedBody,
  });

  // Log the response when it's sent
  const originalEnd = res.end;
  res.end = function (
    this: Response,
    chunk?: any,
    encoding?: string | (() => void),
    callback?: () => void,
  ): Response {
    // Calculate response time
    const responseTime = Date.now() - (req as any)[startTimeSymbol];

    // Log the response
    logResponse(req, res.statusCode, responseTime);

    // Call the original end method
    return originalEnd.call(this, chunk, encoding as BufferEncoding, callback);
  };

  next();
};

/**
 * Sanitize an object to remove sensitive information
 * @param obj The object to sanitize
 * @returns A sanitized copy of the object
 */
function sanitizeObject(obj: any): any {
  if (!obj) {
    return obj;
  }

  // Create a copy of the object
  const sanitized = { ...obj };

  // List of sensitive field names (case-insensitive)
  const sensitiveFields = [
    'password',
    'token',
    'secret',
    'authorization',
    'api_key',
    'apikey',
    'api-key',
    'access_token',
    'accesstoken',
    'access-token',
    'refresh_token',
    'refreshtoken',
    'refresh-token',
    'session',
    'sessionid',
    'session-id',
    'credit_card',
    'creditcard',
    'credit-card',
    'card_number',
    'cardnumber',
    'card-number',
    'cvv',
    'cvc',
    'ssn',
    'social_security',
    'socialsecurity',
    'social-security',
  ];

  // Mask sensitive fields
  Object.keys(sanitized).forEach(key => {
    const lowerKey = key.toLowerCase();

    // Check if the field name contains any sensitive keywords
    if (sensitiveFields.some(field => lowerKey.includes(field))) {
      sanitized[key] = '********';
    }
    // Recursively sanitize nested objects
    else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeObject(sanitized[key]);
    }
  });

  return sanitized;
}

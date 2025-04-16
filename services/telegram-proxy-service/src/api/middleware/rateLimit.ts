import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { RATE_LIMIT } from '../../config';
import { RateLimitError } from '../../utils/errors';

/**
 * Default rate limit configuration
 */
const defaultRateLimitOptions = {
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
    },
  },
  handler: (req: Request, res: Response, next: NextFunction, options: any) => {
    next(new RateLimitError('Too many requests', options.windowMs / 1000));
  },
};

/**
 * Create a rate limiter with custom options
 *
 * @param options Custom rate limit options
 * @returns Rate limit middleware
 */
export function createRateLimiter(options: Partial<typeof defaultRateLimitOptions> = {}) {
  return rateLimit({
    ...defaultRateLimitOptions,
    ...options,
  });
}

/**
 * Default API rate limiter
 * Applies to all API endpoints
 */
export const apiRateLimiter = createRateLimiter();

/**
 * Authentication rate limiter
 * More restrictive for authentication endpoints to prevent brute force attacks
 */
export const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per 15 minutes
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many authentication attempts, please try again later',
    },
  },
});

/**
 * Message sending rate limiter
 * Prevents spam by limiting message sending rate
 */
export const messageSendRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Message sending rate limit exceeded, please try again later',
    },
  },
});

/**
 * Message polling rate limiter
 * Prevents excessive polling for new messages
 */
export const messagePollRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 polls per minute (1 per second)
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Polling rate limit exceeded, please try again later',
    },
  },
});

/**
 * Trusted service rate limiter
 * Higher limits for trusted services
 */
export const trustedServiceRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute
});

/**
 * Rate limit bypass middleware
 * Allows trusted services to bypass rate limits
 */
export const rateLimitBypass = (req: Request, res: Response, next: NextFunction) => {
  // Check for API key or other trusted service identifier
  const apiKey = req.headers['x-api-key'] as string;

  // List of trusted API keys that can bypass rate limits
  const trustedApiKeys = (process.env.TRUSTED_API_KEYS || '').split(',').filter(Boolean);

  // If the request has a trusted API key, set a flag to bypass rate limits
  if (apiKey && trustedApiKeys.includes(apiKey)) {
    (req as any).bypassRateLimit = true;
  }

  next();
};

/**
 * Conditional rate limiter
 * Applies rate limiting only if the request doesn't have the bypass flag
 *
 * @param limiter The rate limiter to apply conditionally
 */
export function conditionalRateLimit(limiter: any) {
  return (req: Request, res: Response, next: NextFunction) => {
    if ((req as any).bypassRateLimit) {
      // Skip rate limiting for trusted services
      return next();
    }

    // Apply rate limiting for normal requests
    return limiter(req, res, next);
  };
}

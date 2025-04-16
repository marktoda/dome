import { Context, MiddlewareHandler, Next } from 'hono';
import { RateLimitError } from '../errors';

/**
 * Simple in-memory rate limiter
 * For production use, consider using a distributed rate limiter with Redis
 */
class RateLimiter {
  private windowMs: number;
  private maxRequests: number;
  private requests: Map<string, { count: number; resetTime: number }>;

  /**
   * Creates a new RateLimiter
   * @param windowMs Time window in milliseconds
   * @param maxRequests Maximum number of requests allowed in the time window
   */
  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  /**
   * Checks if a request is allowed based on the rate limit
   * @param key Identifier for the client (e.g., IP address)
   * @returns Whether the request is allowed
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const clientData = this.requests.get(key);

    // If no previous requests or window has expired, reset the counter
    if (!clientData || now > clientData.resetTime) {
      this.requests.set(key, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return true;
    }

    // If under the limit, increment the counter
    if (clientData.count < this.maxRequests) {
      clientData.count++;
      return true;
    }

    // Rate limit exceeded
    return false;
  }

  /**
   * Gets the remaining requests for a client
   * @param key Identifier for the client
   * @returns Remaining requests and reset time
   */
  getRemainingRequests(key: string): { remaining: number; resetTime: number } {
    const now = Date.now();
    const clientData = this.requests.get(key);

    if (!clientData || now > clientData.resetTime) {
      return {
        remaining: this.maxRequests,
        resetTime: now + this.windowMs
      };
    }

    return {
      remaining: Math.max(0, this.maxRequests - clientData.count),
      resetTime: clientData.resetTime
    };
  }

  /**
   * Cleans up expired entries periodically
   */
  startCleanup(): NodeJS.Timeout {
    return setInterval(() => {
      const now = Date.now();
      for (const [key, data] of this.requests.entries()) {
        if (now > data.resetTime) {
          this.requests.delete(key);
        }
      }
    }, this.windowMs);
  }
}

/**
 * Creates a rate limiting middleware
 * @param windowMs Time window in milliseconds (default: 60000 ms = 1 minute)
 * @param maxRequests Maximum number of requests allowed in the time window (default: 100)
 * @param keyGenerator Function to generate a key for the client (default: uses IP address)
 * @returns Middleware handler
 */
export function createRateLimitMiddleware(
  windowMs: number = 60000,
  maxRequests: number = 100,
  keyGenerator: (c: Context) => string = (c) => c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown'
): MiddlewareHandler {
  const limiter = new RateLimiter(windowMs, maxRequests);

  // Start cleanup interval
  const cleanupInterval = limiter.startCleanup();

  // Ensure cleanup interval is cleared when the worker terminates
  if (typeof self !== 'undefined' && 'addEventListener' in self) {
    // Use 'beforeunload' for Cloudflare Workers environment
    self.addEventListener('fetch', () => {
      // This is a workaround since Cloudflare Workers don't have a direct 'unload' event
      // We'll rely on garbage collection to clean up the interval
    });
  }

  return async (c: Context, next: Next) => {
    const key = keyGenerator(c);

    if (!limiter.isAllowed(key)) {
      console.warn(`Rate limit exceeded for client ${key}`);

      const { resetTime } = limiter.getRemainingRequests(key);
      const resetDate = new Date(resetTime).toISOString();

      // Set rate limit headers
      c.header('X-RateLimit-Limit', maxRequests.toString());
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', resetDate);

      throw new RateLimitError('Too many requests, please try again later');
    }

    // Get remaining requests
    const { remaining, resetTime } = limiter.getRemainingRequests(key);
    const resetDate = new Date(resetTime).toISOString();

    // Set rate limit headers
    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', resetDate);

    await next();
  };
}
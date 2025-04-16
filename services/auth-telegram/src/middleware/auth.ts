/**
 * Authentication middleware
 */
import type { Context, Next } from 'hono';
import type { ApiResponse } from '@communicator/common';

/**
 * Environment bindings type
 */
type Bindings = {
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  SESSION_SECRET: string;
  DB: D1Database;
  API_KEY: string;
  ADMIN_API_KEY: string;
};

/**
 * API key authentication middleware
 * Validates API key from Authorization header
 */
export function apiKeyAuth(
  apiKey: string | ((c: Context<{ Bindings: Bindings; Variables?: any }>) => string),
) {
  return async (c: Context<{ Bindings: Bindings; Variables?: any }>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('ApiKey ')) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'API key is required',
        },
      };

      return c.json(response, 401);
    }

    const providedApiKey = authHeader.replace('ApiKey ', '');

    if (providedApiKey !== apiKey) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid API key',
        },
      };

      return c.json(response, 401);
    }

    // Add service info to context
    // Use type assertion to work around type checking issues
    (c as any).set('serviceId', c.req.header('X-Service-ID') || 'unknown');

    await next();
  };
}

/**
 * Admin authentication middleware
 * Validates admin API key
 */
export function adminAuth(
  adminApiKey: string | ((c: Context<{ Bindings: Bindings; Variables?: any }>) => string),
) {
  return async (c: Context<{ Bindings: Bindings; Variables?: any }>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('AdminKey ')) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Admin key is required',
        },
      };

      return c.json(response, 401);
    }

    const providedApiKey = authHeader.replace('AdminKey ', '');

    if (providedApiKey !== adminApiKey) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid admin key',
        },
      };

      return c.json(response, 401);
    }

    await next();
  };
}

/**
 * Rate limiting middleware
 * Simple in-memory rate limiting
 */
export function rateLimit(limit: number, windowMs: number) {
  // In-memory store for rate limiting
  // Note: This is per-worker instance and will reset on worker restart
  const ipRequests: Record<string, { count: number; resetTime: number }> = {};

  return async (c: Context<{ Bindings: Bindings; Variables?: any }>, next: Next) => {
    const ip = c.req.header('CF-Connecting-IP') || 'unknown';
    const now = Date.now();

    // Initialize or reset if window has passed
    if (!ipRequests[ip] || ipRequests[ip].resetTime < now) {
      ipRequests[ip] = {
        count: 0,
        resetTime: now + windowMs,
      };
    }

    // Increment request count
    ipRequests[ip].count++;

    // Check if over limit
    if (ipRequests[ip].count > limit) {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
        },
      };

      return c.json(response, 429);
    }

    await next();
  };
}

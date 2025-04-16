/**
 * Telegram Authentication Service
 *
 * This service provides authentication with Telegram using the MTProto protocol.
 * It exposes methods for session management that can be called directly by other
 * services using Cloudflare service bindings.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { ApiResponse, ServiceInfo } from '@communicator/common';
import routes from './routes';
import { SessionManager } from './lib/session-manager';

/**
 * Environment bindings type
 */
type Bindings = {
  ENVIRONMENT?: string;
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  SESSION_SECRET: string;
  DB: D1Database;
  API_KEY: string;
  ADMIN_API_KEY: string;
  TELEGRAM_PROXY_URL?: string;
  TELEGRAM_PROXY_API_KEY?: string;
  USE_TELEGRAM_PROXY?: string;
};

/**
 * Extend WorkerEntrypoint with our environment bindings
 */
declare abstract class TypedWorkerEntrypoint<Env = unknown> extends WorkerEntrypoint {
  readonly env: Env;
}

/**
 * Service information
 */
const serviceInfo: ServiceInfo = {
  name: 'auth-telegram',
  version: '0.1.0',
  environment: 'development', // Default value, will be overridden by env
};

/**
 * Telegram Auth Worker that extends WorkerEntrypoint for RPC-style service bindings
 */
export default class TelegramAuthWorker extends WorkerEntrypoint {
  // Explicitly declare env property with the correct type
  declare readonly env: Bindings;
  /**
   * Handle HTTP requests using Hono
   * This maintains backward compatibility with HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    // Create Hono app
    const app = new Hono<{ Bindings: Bindings }>();

    // Middleware
    app.use('*', logger());
    app.use('*', cors());

    // Middleware to set service info from environment
    app.use('*', async (c, next) => {
      if (this.env.ENVIRONMENT) {
        serviceInfo.environment = this.env.ENVIRONMENT;
      }
      await next();
    });

    // Error handling middleware
    app.onError((err, c) => {
      console.error(`Error: ${err.message}`);

      const response: ApiResponse = {
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
        },
      };

      return c.json(response, 500);
    });

    // Not found handler
    app.notFound(c => {
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'The requested resource was not found',
        },
      };

      return c.json(response, 404);
    });

    // Root route
    app.get('/', c => {
      const response: ApiResponse = {
        success: true,
        data: {
          message: 'Telegram Authentication Service',
          service: serviceInfo,
        },
      };

      return c.json(response);
    });

    // Mount API routes
    app.route('/api/telegram-auth', routes);

    // Health check endpoint
    app.get('/health', c =>
      c.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
      }),
    );

    // Handle the request with Hono
    return app.fetch(request, this.env as any);
  }

  /**
   * Get a session for a user
   * This method can be called directly by other services using service bindings
   *
   * @param userId - The user ID
   * @returns The session data
   */
  async getSessionByUserId(userId: number): Promise<{
    sessionString: string;
    sessionId: string;
    expiresAt: string;
  }> {
    const sessionManager = new SessionManager(this.env.DB, this.env.SESSION_SECRET);

    try {
      // Get session for user
      const { sessionString, sessionId, expiresAt } = await sessionManager.getSessionByUserId(
        userId,
      );

      // Log access
      await sessionManager.logAccess(
        sessionId,
        'ingestor-service', // Service ID
        'get_session',
        true,
        undefined,
        'internal-service-binding', // IP address
      );

      return {
        sessionString,
        sessionId,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error: any) {
      console.error(`Error getting session: ${error.message}`);

      // Log failed access if we have a session ID
      if (error.sessionId) {
        await sessionManager.logAccess(
          error.sessionId,
          'ingestor-service',
          'get_session',
          false,
          error.message,
          'internal-service-binding',
        );
      }

      throw new Error(error.message || 'Session not found or expired');
    }
  }

  /**
   * List all sessions for a user
   * This method can be called directly by other services using service bindings
   *
   * @param userId - The user ID
   * @returns Array of session data
   */
  async listSessions(userId: number) {
    const sessionManager = new SessionManager(this.env.DB, this.env.SESSION_SECRET);

    try {
      // Get all sessions for user
      const sessions = await sessionManager.listSessions(userId);

      // Map to response format (without sensitive data)
      return sessions.map(session => ({
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        lastUsedAt: session.lastUsedAt?.toISOString(),
        expiresAt: session.expiresAt?.toISOString(),
        isActive: session.isActive,
        deviceInfo: session.deviceInfo,
        ipAddress: session.ipAddress,
      }));
    } catch (error: any) {
      console.error(`Error listing sessions: ${error.message}`);
      throw new Error(error.message || 'Failed to list sessions');
    }
  }

  /**
   * Revoke a session
   * This method can be called directly by other services using service bindings
   *
   * @param sessionId - The session ID
   */
  async revokeSession(sessionId: string): Promise<void> {
    const sessionManager = new SessionManager(this.env.DB, this.env.SESSION_SECRET);

    try {
      // Revoke the session
      await sessionManager.revokeSession(sessionId);

      // Log access
      await sessionManager.logAccess(
        sessionId,
        'ingestor-service',
        'revoke_session',
        true,
        undefined,
        'internal-service-binding',
      );
    } catch (error: any) {
      console.error(`Error revoking session: ${error.message}`);

      // Log failed access
      await sessionManager.logAccess(
        sessionId,
        'ingestor-service',
        'revoke_session',
        false,
        error.message,
        'internal-service-binding',
      );

      throw new Error(error.message || 'Failed to revoke session');
    }
  }
}

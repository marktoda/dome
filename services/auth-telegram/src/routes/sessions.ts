/**
 * Session management routes
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { SessionManager } from '../lib/session-manager';
import { TelegramAuthHandler } from '../handlers/auth-handler';
import { ApiResponse } from '@communicator/common';
import { 
  sessionIdSchema,
  userIdSchema,
  apiKeySchema,
  serviceIdSchema
} from '../utils/validation';
import { apiKeyAuth, adminAuth } from '../middleware/auth';

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
 * Create router
 */
const router = new Hono<{ Bindings: Bindings; Variables: { serviceId: string } }>();

/**
 * Get session for a user
 * GET /api/telegram-auth/sessions/user/:userId
 * Requires API key authentication
 */
router.get(
  '/user/:userId',
  // Use type assertion to work around type checking issues
  apiKeyAuth((c) => c.env.API_KEY) as any,
  zValidator('param', userIdSchema) as any,
  async (c) => {
    const userId = parseInt(c.req.param('userId'), 10);
    const serviceId = c.get('serviceId');
    
    const sessionManager = new SessionManager(
      c.env.DB,
      c.env.SESSION_SECRET
    );
    
    try {
      // Get session for user
      const { sessionString, sessionId, expiresAt } = await sessionManager.getSessionByUserId(userId);
      
      // Log access
      await sessionManager.logAccess(
        sessionId,
        serviceId,
        'get_session',
        true,
        undefined,
        c.req.header('CF-Connecting-IP')
      );
      
      const response: ApiResponse = {
        success: true,
        data: {
          sessionString,
          sessionId,
          expiresAt: expiresAt.toISOString()
        }
      };
      
      return c.json(response);
    } catch (error: any) {
      console.error(`Error getting session: ${error.message}`);
      
      // Log failed access if we have a session ID
      if (error.sessionId) {
        await sessionManager.logAccess(
          error.sessionId,
          serviceId,
          'get_session',
          false,
          error.message,
          c.req.header('CF-Connecting-IP')
        );
      }
      
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: error.message || 'Session not found or expired'
        }
      };
      
      return c.json(response, 404);
    }
  }
);

/**
 * List all sessions for a user
 * GET /api/telegram-auth/sessions/list/:userId
 * Admin only
 */
router.get(
  '/list/:userId',
  // Use type assertion to work around type checking issues
  adminAuth((c) => c.env.ADMIN_API_KEY) as any,
  zValidator('param', userIdSchema) as any,
  async (c) => {
    const userId = parseInt(c.req.param('userId'), 10);
    
    const sessionManager = new SessionManager(
      c.env.DB,
      c.env.SESSION_SECRET
    );
    
    try {
      // Get all sessions for user
      const sessions = await sessionManager.listSessions(userId);
      
      // Map to response format (without sensitive data)
      const sessionList = sessions.map(session => ({
        id: session.id,
        userId: session.userId,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        lastUsedAt: session.lastUsedAt?.toISOString(),
        expiresAt: session.expiresAt?.toISOString(),
        isActive: session.isActive,
        deviceInfo: session.deviceInfo,
        ipAddress: session.ipAddress
      }));
      
      const response: ApiResponse = {
        success: true,
        data: {
          sessions: sessionList
        }
      };
      
      return c.json(response);
    } catch (error: any) {
      console.error(`Error listing sessions: ${error.message}`);
      
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'LIST_SESSIONS_FAILED',
          message: error.message || 'Failed to list sessions'
        }
      };
      
      return c.json(response, 500);
    }
  }
);

/**
 * Revoke a session
 * DELETE /api/telegram-auth/sessions/:sessionId
 * Requires API key authentication
 */
router.delete(
  '/:sessionId',
  // Use type assertion to work around type checking issues
  apiKeyAuth((c) => c.env.API_KEY) as any,
  zValidator('param', sessionIdSchema) as any,
  async (c) => {
    const sessionId = c.req.param('sessionId');
    const serviceId = c.get('serviceId');
    
    const sessionManager = new SessionManager(
      c.env.DB,
      c.env.SESSION_SECRET
    );
    
    try {
      // Revoke the session
      await sessionManager.revokeSession(sessionId);
      
      // Log access
      await sessionManager.logAccess(
        sessionId,
        serviceId,
        'revoke_session',
        true,
        undefined,
        c.req.header('CF-Connecting-IP')
      );
      
      const response: ApiResponse = {
        success: true,
        data: {
          message: 'Session revoked successfully'
        }
      };
      
      return c.json(response);
    } catch (error: any) {
      console.error(`Error revoking session: ${error.message}`);
      
      // Log failed access
      await sessionManager.logAccess(
        sessionId,
        serviceId,
        'revoke_session',
        false,
        error.message,
        c.req.header('CF-Connecting-IP')
      );
      
      const response: ApiResponse = {
        success: false,
        error: {
          code: 'REVOKE_SESSION_FAILED',
          message: error.message || 'Failed to revoke session'
        }
      };
      
      return c.json(response, 500);
    }
  }
);

export default router;
/**
 * Authentication routes
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { TelegramAuthHandler } from '../handlers/auth-handler';
import { SessionManager } from '../lib/session-manager';
import { ApiResponse } from '@communicator/common';
import { 
  sendCodeRequestSchema, 
  verifyCodeRequestSchema 
} from '../utils/validation';
import { rateLimit } from '../middleware/auth';

/**
 * Environment bindings type
 */
type Bindings = {
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  SESSION_SECRET: string;
  DB: D1Database;
};

/**
 * Create router
 */
const router = new Hono<{ Bindings: Bindings }>();

/**
 * Apply rate limiting to all auth endpoints
 * 10 requests per minute
 */
router.use('*', rateLimit(10, 60 * 1000));

/**
 * Send code endpoint
 * POST /api/telegram-auth/send-code
 */
router.post('/send-code', zValidator('json', sendCodeRequestSchema), async (c) => {
  const { phoneNumber } = c.req.valid('json');
  
  const authHandler = new TelegramAuthHandler(
    c.env.TELEGRAM_API_ID,
    c.env.TELEGRAM_API_HASH
  );
  
  try {
    const result = await authHandler.sendAuthCode(phoneNumber);
    
    const response: ApiResponse = {
      success: true,
      data: result
    };
    
    return c.json(response);
  } catch (error: any) {
    console.error(`Error sending code: ${error.message}`);
    
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'SEND_CODE_FAILED',
        message: error.message || 'An unexpected error occurred'
      }
    };
    
    return c.json(response, 500);
  }
});

/**
 * Verify code endpoint
 * POST /api/telegram-auth/verify-code
 */
router.post('/verify-code', zValidator('json', verifyCodeRequestSchema), async (c) => {
  const { phoneNumber, phoneCodeHash, code } = c.req.valid('json');
  
  const authHandler = new TelegramAuthHandler(
    c.env.TELEGRAM_API_ID,
    c.env.TELEGRAM_API_HASH,
    c.env.DB,
    c.env.SESSION_SECRET
  );
  
  try {
    // Get device and IP information
    const deviceInfo = c.req.header('User-Agent');
    const ipAddress = c.req.header('CF-Connecting-IP');
    
    // Verify the code with Telegram
    const { sessionId, expiresAt } = await authHandler.verifyAuthCode(
      phoneNumber,
      phoneCodeHash,
      code,
      deviceInfo,
      ipAddress
    );
    
    const response: ApiResponse = {
      success: true,
      data: {
        sessionId,
        expiresAt: expiresAt.toISOString()
      }
    };
    
    return c.json(response);
  } catch (error: any) {
    console.error(`Error verifying code: ${error.message}`);
    
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'VERIFY_CODE_FAILED',
        message: error.message || 'An unexpected error occurred'
      }
    };
    
    return c.json(response, 500);
  }
});

/**
 * Status endpoint
 * GET /api/telegram-auth/status
 */
router.get('/status', async (c) => {
  // Get session ID from header or query
  const sessionId = c.req.header('X-Session-ID') || c.req.query('sessionId');
  
  if (!sessionId) {
    const response: ApiResponse = {
      success: true,
      data: {
        authenticated: false
      }
    };
    
    return c.json(response);
  }
  
  const sessionManager = new SessionManager(
    c.env.DB,
    c.env.SESSION_SECRET
  );
  
  try {
    // Try to get the session
    await sessionManager.getSession(sessionId);
    
    // Get session details
    const sessions = await c.env.DB.prepare(`
      SELECT user_id, expires_at FROM telegram_sessions
      WHERE id = ? AND is_active = 1
    `).bind(sessionId).first<{ user_id: number; expires_at: string }>();
    
    if (!sessions) {
      throw new Error('Session not found');
    }
    
    const response: ApiResponse = {
      success: true,
      data: {
        authenticated: true,
        userId: sessions.user_id,
        sessionExpiresAt: sessions.expires_at
      }
    };
    
    return c.json(response);
  } catch (error) {
    const response: ApiResponse = {
      success: true,
      data: {
        authenticated: false
      }
    };
    
    return c.json(response);
  }
});

/**
 * Health check endpoint
 * GET /api/telegram-auth/health
 */
router.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

export default router;
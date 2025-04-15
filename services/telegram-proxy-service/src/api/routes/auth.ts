import { Router, Request, Response } from 'express';
import { body } from 'express-validator';
import { sessionManager } from '../../telegram/sessionManager';
import { validate } from '../middleware/validation';
import { authRateLimiter } from '../middleware/rateLimit';
import { generateAuthToken, generateRefreshToken, verifyRefreshToken } from '../middleware/auth';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../../utils/errors';
import { PHONE_NUMBER_REGEX } from '../middleware/validation';
import { AuthenticationError } from '../../utils/errors';

const router: Router = Router();

/**
 * @route POST /api/auth/send-code
 * @desc Send authentication code to a phone number
 * @access Public
 */
router.post(
  '/send-code',
  authRateLimiter,
  validate([
    body('phoneNumber')
      .matches(PHONE_NUMBER_REGEX)
      .withMessage('Invalid phone number format'),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { phoneNumber } = req.body as { phoneNumber: string };
    
    const result = await sessionManager.startAuthFlow(phoneNumber);
    
    sendSuccess(res as any, result);
  })
);

/**
 * @route POST /api/auth/verify-code
 * @desc Verify authentication code and complete authentication
 * @access Public
 */
router.post(
  '/verify-code',
  authRateLimiter,
  validate([
    body('phoneNumber')
      .matches(PHONE_NUMBER_REGEX)
      .withMessage('Invalid phone number format'),
    body('phoneCode')
      .notEmpty()
      .withMessage('Phone code is required'),
    body('phoneCodeHash')
      .notEmpty()
      .withMessage('Phone code hash is required'),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { phoneNumber, phoneCode, phoneCodeHash } = req.body as {
      phoneNumber: string;
      phoneCode: string;
      phoneCodeHash: string;
    };
    
    const result = await sessionManager.completeAuth(
      phoneNumber,
      phoneCode,
      phoneCodeHash
    );
    
    if (!result.success) {
      throw new AuthenticationError(result.error || 'Authentication failed');
    }
    
    // Generate tokens
    const authToken = generateAuthToken(result.sessionId, result.userId || '', 'user');
    const refreshToken = generateRefreshToken(result.sessionId, result.userId || '');
    
    sendSuccess(res as any, {
      sessionId: result.sessionId,
      userId: result.userId,
      authToken,
      refreshToken,
    });
  })
);

/**
 * @route POST /api/auth/refresh
 * @desc Refresh authentication token using refresh token
 * @access Public
 */
router.post(
  '/refresh',
  authRateLimiter,
  validate([
    body('refreshToken')
      .notEmpty()
      .withMessage('Refresh token is required'),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body as { refreshToken: string };
    
    // Verify refresh token
    const payload = verifyRefreshToken(refreshToken);
    
    // Validate session
    const isValid = await sessionManager.validateSession(payload.sessionId);
    
    if (!isValid) {
      throw new AuthenticationError('Session is no longer valid');
    }
    
    // Generate new tokens
    const authToken = generateAuthToken(payload.sessionId, payload.userId!, 'user');
    const newRefreshToken = generateRefreshToken(payload.sessionId, payload.userId!);
    
    sendSuccess(res as any, {
      sessionId: payload.sessionId,
      userId: payload.userId,
      authToken,
      refreshToken: newRefreshToken,
    });
  })
);

export default router;
import type { Request, Response } from 'express';
import { Router } from 'express';
import { param } from 'express-validator';
import { sessionManager } from '../../telegram/sessionManager';
import { sessionStore } from '../../storage/sessionStore';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { sendSuccess, sendNoContent } from '../utils/response';
import { asyncHandler } from '../../utils/errors';
import { NotFoundError, AuthorizationError } from '../../utils/errors';

const router: Router = Router();

/**
 * @route GET /api/sessions
 * @desc Get all sessions for the authenticated user
 * @access Private
 */
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).userId;

    // Get all sessions for the user
    const sessions = await sessionStore.listUserSessions(userId);

    sendSuccess(res as any, {
      sessions: sessions || [],
    });
  }),
);

/**
 * @route GET /api/sessions/:id
 * @desc Get session details by ID
 * @access Private
 */
router.get(
  '/:id',
  authenticate,
  validate([param('id').notEmpty().withMessage('Session ID is required')]),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).userId;

    const session = await sessionStore.getSession(id);

    if (!session) {
      throw new NotFoundError(`Session not found: ${id}`);
    }

    // Ensure the user can only access their own sessions
    if (session.userId !== userId) {
      throw new AuthorizationError('Not authorized to access this session');
    }

    sendSuccess(res as any, {
      session,
    });
  }),
);

/**
 * @route DELETE /api/sessions/:id
 * @desc Revoke a session
 * @access Private
 */
router.delete(
  '/:id',
  authenticate,
  validate([param('id').notEmpty().withMessage('Session ID is required')]),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).userId;

    // Get the session to check ownership
    const session = await sessionStore.getSession(id);

    if (!session) {
      throw new NotFoundError(`Session not found: ${id}`);
    }

    // Ensure the user can only revoke their own sessions
    if (session.userId !== userId) {
      throw new AuthorizationError('Not authorized to revoke this session');
    }

    const result = await sessionManager.terminateSession(id);

    if (result) {
      sendNoContent(res as any);
    } else {
      sendSuccess(res as any, {
        terminated: false,
        message: 'Session could not be terminated',
      });
    }
  }),
);

/**
 * @route GET /api/sessions/user/:userId
 * @desc Get sessions for a user (admin only)
 * @access Private (Admin)
 */
router.get(
  '/user/:userId',
  authenticate,
  validate([param('userId').notEmpty().withMessage('User ID is required')]),
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const requestingUserId = (req as any).userId;
    const role = (req as any).role;

    // Only admins can view other users' sessions
    if (userId !== requestingUserId && role !== 'admin') {
      throw new AuthorizationError("Not authorized to view other users' sessions");
    }

    const sessions = await sessionStore.listUserSessions(userId);

    sendSuccess(res as any, {
      sessions: sessions || [],
    });
  }),
);

/**
 * @route GET /api/sessions/status/:id
 * @desc Check if a session is valid
 * @access Private
 */
router.get(
  '/status/:id',
  authenticate,
  validate([param('id').notEmpty().withMessage('Session ID is required')]),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).userId;

    // Get the session to check ownership
    const session = await sessionStore.getSession(id);

    if (!session) {
      throw new NotFoundError(`Session not found: ${id}`);
    }

    // Ensure the user can only check their own sessions
    if (session.userId !== userId && (req as any).role !== 'admin') {
      throw new AuthorizationError('Not authorized to check this session');
    }

    const isValid = await sessionManager.validateSession(id);

    sendSuccess(res as any, {
      sessionId: id,
      isValid,
    });
  }),
);

export default router;

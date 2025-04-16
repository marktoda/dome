import type { Request, Response } from 'express';
import { Router } from 'express';
import { param, query, body } from 'express-validator';
import { sessionManager } from '../../telegram/sessionManager';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validation';
import { messagePollRateLimiter, messageSendRateLimiter } from '../middleware/rateLimit';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../../utils/errors';

const router: Router = Router();

/**
 * @route GET /api/messages/:chatId
 * @desc Get messages from a chat
 * @access Private
 */
router.get(
  '/:chatId',
  authenticate,
  messagePollRateLimiter,
  validate([
    param('chatId').notEmpty().withMessage('Chat ID is required'),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('cursor').optional().isString(),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { limit = 50, cursor } = req.query;
    const sessionId = (req as any).sessionId;

    // Use the session manager to execute an operation with the session
    const messages = await sessionManager.withSession(sessionId, async client => {
      // This is a simplified implementation
      // In a real implementation, you would use proper pagination with the cursor
      const limitNum = parseInt(limit as string, 10);
      if (cursor) {
        return client.getHistory(chatId, limitNum, parseInt(cursor as string, 10));
      }
      return client.getMessages(chatId, limitNum);
    });

    // Extract the ID of the last message for cursor-based pagination
    const nextCursor =
      messages.messages.length > 0
        ? messages.messages[messages.messages.length - 1].id.toString()
        : null;

    sendSuccess(
      res as any,
      {
        messages: messages.messages,
        users: messages.users,
        chats: messages.chats,
      },
      {
        pagination: {
          cursor: (cursor as string) || null,
          nextCursor,
          count: messages.messages.length,
          hasMore: nextCursor !== null,
        },
      },
    );
  }),
);

/**
 * @route GET /api/messages/history/:chatId
 * @desc Get message history from a chat with offset-based pagination
 * @access Private
 */
router.get(
  '/history/:chatId',
  authenticate,
  messagePollRateLimiter,
  validate([
    param('chatId').notEmpty().withMessage('Chat ID is required'),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offsetId').optional().isInt({ min: 0 }).toInt(),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { limit = 50, offsetId = 0 } = req.query;
    const sessionId = (req as any).sessionId;

    const messages = await sessionManager.withSession(sessionId, async client =>
      client.getHistory(chatId, parseInt(limit as string, 10), parseInt(offsetId as string, 10)),
    );

    sendSuccess(
      res as any,
      {
        messages: messages.messages,
        users: messages.users,
        chats: messages.chats,
      },
      {
        count: messages.messages.length,
      },
    );
  }),
);

/**
 * @route POST /api/messages/:chatId
 * @desc Send a message to a chat
 * @access Private
 */
router.post(
  '/:chatId',
  authenticate,
  messageSendRateLimiter,
  validate([
    param('chatId').notEmpty().withMessage('Chat ID is required'),
    body('message').notEmpty().withMessage('Message content is required'),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { message } = req.body;
    const sessionId = (req as any).sessionId;

    const result = await sessionManager.withSession(sessionId, async client =>
      client.sendMessage(chatId, message),
    );

    sendSuccess(res as any, {
      result,
    });
  }),
);

/**
 * @route GET /api/messages/poll/:chatId
 * @desc Poll for new messages in a chat
 * @access Private
 */
router.get(
  '/poll/:chatId',
  authenticate,
  messagePollRateLimiter,
  validate([
    param('chatId').notEmpty().withMessage('Chat ID is required'),
    query('timeout').optional().isInt({ min: 1, max: 30 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ]),
  asyncHandler(async (req: Request, res: Response) => {
    const { chatId } = req.params;
    const { timeout = 10, limit = 50 } = req.query;
    const sessionId = (req as any).sessionId;

    // Set a timeout for long polling
    const timeoutMs = parseInt(timeout as string, 10) * 1000;
    const limitNum = parseInt(limit as string, 10);

    // Get the last message ID to use as a reference point
    const lastMessages = await sessionManager.withSession(sessionId, async client =>
      client.getMessages(chatId, 1),
    );

    const lastMessageId = lastMessages.messages.length > 0 ? lastMessages.messages[0].id : 0;

    // Set up polling with timeout
    const pollStart = Date.now();
    let newMessages = null;

    // Poll until we get new messages or timeout
    while (Date.now() - pollStart < timeoutMs) {
      newMessages = await sessionManager.withSession(sessionId, async client =>
        client.getMessages(chatId, limitNum),
      );

      // Check if we have new messages (with ID greater than lastMessageId)
      const hasNewMessages = newMessages.messages.some(msg => msg.id > lastMessageId);

      if (hasNewMessages) {
        break;
      }

      // Wait a bit before polling again
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // If we have messages, return them
    if (newMessages) {
      sendSuccess(
        res as any,
        {
          messages: newMessages.messages,
          users: newMessages.users,
          chats: newMessages.chats,
        },
        {
          count: newMessages.messages.length,
        },
      );
    } else {
      // If we timed out without new messages
      sendSuccess(
        res as any,
        {
          messages: [],
          users: [],
          chats: [],
        },
        {
          count: 0,
        },
      );
    }
  }),
);

export default router;

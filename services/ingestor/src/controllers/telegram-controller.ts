import type { Context } from 'hono';
import type { ApiResponse } from '@communicator/common';
import type { ITelegramService } from '../services/telegram-service-interface';

/**
 * Controller for Telegram-related endpoints
 */
export class TelegramController {
  private telegramService: ITelegramService;

  /**
   * Create a new TelegramController
   * @param telegramService Telegram service
   */
  constructor(telegramService: ITelegramService) {
    this.telegramService = telegramService;
  }

  /**
   * Get messages from a Telegram channel or chat
   * @param c Hono context
   * @returns API response with messages
   */
  async getMessages(c: Context): Promise<Response> {
    try {
      const { userId, source } = c.req.param();
      const { limit, offsetId } = c.req.query();

      // Validate parameters
      if (!userId || !source) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_PARAMETERS',
            message: 'Missing required parameters: userId and source',
          },
        };
        return c.json(response, 400);
      }

      // Parse parameters
      const userIdNum = parseInt(userId, 10);
      const limitNum = limit ? parseInt(limit, 10) : undefined;
      const offsetIdNum = offsetId ? parseInt(offsetId, 10) : undefined;

      // Collect messages
      const messages = await this.telegramService.collectMessages(userIdNum, source, {
        limit: limitNum,
        offsetId: offsetIdNum,
      });

      // Return response
      const response: ApiResponse = {
        success: true,
        data: {
          messages,
          source,
          userId: userIdNum,
          count: messages.length,
        },
      };

      return c.json(response);
    } catch (error) {
      console.error('Error getting messages:', error);

      const response: ApiResponse = {
        success: false,
        error: {
          code: 'TELEGRAM_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };

      return c.json(response, 500);
    }
  }

  /**
   * Get media from a Telegram channel or chat
   * @param c Hono context
   * @returns API response with media items
   */
  async getMedia(c: Context): Promise<Response> {
    try {
      const { userId, source } = c.req.param();
      const { limit, offsetId, mediaType } = c.req.query();

      // Validate parameters
      if (!userId || !source) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_PARAMETERS',
            message: 'Missing required parameters: userId and source',
          },
        };
        return c.json(response, 400);
      }

      // Parse parameters
      const userIdNum = parseInt(userId, 10);
      const limitNum = limit ? parseInt(limit, 10) : undefined;
      const offsetIdNum = offsetId ? parseInt(offsetId, 10) : undefined;

      // Collect media
      const media = await this.telegramService.collectMedia(userIdNum, source, {
        limit: limitNum,
        offsetId: offsetIdNum,
        mediaType,
      });

      // Return response
      const response: ApiResponse = {
        success: true,
        data: {
          media,
          source,
          userId: userIdNum,
          count: media.length,
        },
      };

      return c.json(response);
    } catch (error) {
      console.error('Error getting media:', error);

      const response: ApiResponse = {
        success: false,
        error: {
          code: 'TELEGRAM_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };

      return c.json(response, 500);
    }
  }

  /**
   * Get information about a Telegram channel or chat
   * @param c Hono context
   * @returns API response with source information
   */
  async getSourceInfo(c: Context): Promise<Response> {
    try {
      const { userId, source } = c.req.param();

      // Validate parameters
      if (!userId || !source) {
        const response: ApiResponse = {
          success: false,
          error: {
            code: 'INVALID_PARAMETERS',
            message: 'Missing required parameters: userId and source',
          },
        };
        return c.json(response, 400);
      }

      // Parse parameters
      const userIdNum = parseInt(userId, 10);

      // Get source info
      const sourceInfo = await this.telegramService.getSourceInfo(userIdNum, source);

      // Return response
      const response: ApiResponse = {
        success: true,
        data: {
          sourceInfo,
          source,
          userId: userIdNum,
        },
      };

      return c.json(response);
    } catch (error) {
      console.error('Error getting source info:', error);

      const response: ApiResponse = {
        success: false,
        error: {
          code: 'TELEGRAM_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };

      return c.json(response, 500);
    }
  }
}

import { Router, Request, Response } from 'express';
import { redisService } from '../../storage/redis';
import { clientPool } from '../../telegram/clientPool';
import { sendSuccess } from '../utils/response';
import { asyncHandler } from '../../utils/errors';

const router: Router = Router();

/**
 * @route GET /api/health
 * @desc Get overall service health status
 * @access Public
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    // Check Redis health
    const redisHealth = await redisService.healthCheck();
    const redisStatus = redisService.getStatus();
    
    // Check Telegram connection status
    const telegramStatus = {
      clientPool: {
        total: clientPool.getTotalCount(),
        available: clientPool.getAvailableCount(),
      }
    };
    
    // Overall system health status
    const status = redisHealth ? 'ok' : 'degraded';
    
    sendSuccess(res as any, {
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        redis: {
          status: redisHealth ? 'ok' : 'error',
          connectionStatus: redisStatus
        },
        telegram: telegramStatus
      }
    });
  })
);

/**
 * @route GET /api/health/redis
 * @desc Get Redis health status
 * @access Public
 */
router.get(
  '/redis',
  asyncHandler(async (req: Request, res: Response) => {
    const redisHealth = await redisService.healthCheck();
    const redisStatus = redisService.getStatus();
    
    sendSuccess(res as any, {
      status: redisHealth ? 'ok' : 'error',
      connectionStatus: redisStatus,
      timestamp: new Date().toISOString()
    });
  })
);

/**
 * @route GET /api/health/telegram
 * @desc Get Telegram connection status
 * @access Public
 */
router.get(
  '/telegram',
  asyncHandler(async (req: Request, res: Response) => {
    const clientPoolStatus = {
      total: clientPool.getTotalCount(),
      available: clientPool.getAvailableCount(),
    };
    
    // Determine status based on available clients
    const status = clientPoolStatus.available > 0 ? 'ok' : 'degraded';
    
    sendSuccess(res as any, {
      status,
      clientPool: clientPoolStatus,
      timestamp: new Date().toISOString()
    });
  })
);

/**
 * @route GET /api/health/metrics
 * @desc Get detailed service metrics
 * @access Public
 */
router.get(
  '/metrics',
  asyncHandler(async (req: Request, res: Response) => {
    const metrics = {
      clientPool: {
        total: clientPool.getTotalCount(),
        available: clientPool.getAvailableCount(),
      },
      redis: {
        status: redisService.getStatus(),
        connectionCount: redisService.getClient() ? 1 : 0,
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString(),
      }
    };
    
    sendSuccess(res as any, metrics);
  })
);

export default router;
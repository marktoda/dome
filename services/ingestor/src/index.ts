import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { ApiResponse, ServiceInfo } from '@communicator/common';
import { TelegramAuthClient } from './clients/telegram-auth-client';
import { TelegramService } from './services/telegram-service';
import { TelegramController } from './controllers/telegram-controller';
import { getTelegramConfig } from './config/telegram-config';

/**
 * Custom variables for Hono context
 */
type Variables = {
  telegramController: TelegramController;
};

/**
 * Environment bindings type
 */
type Bindings = {
  ENVIRONMENT?: string;
  TELEGRAM_API_ID?: string;
  TELEGRAM_API_HASH?: string;
  TELEGRAM_AUTH: any; // Service binding
  TELEGRAM_SERVICE_ID?: string;
  TELEGRAM_MAX_RETRIES?: string;
  TELEGRAM_RETRY_DELAY?: string;
  TELEGRAM_SESSION_CACHE_TTL?: string;
};

/**
 * Service information
 */
const serviceInfo: ServiceInfo = {
  name: 'ingestor',
  version: '0.1.0',
  environment: 'development' // Default value, will be overridden by env
};

/**
 * Create Hono app
 */
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * Middleware
 */
app.use('*', logger());
app.use('*', cors());

/**
 * Middleware to set service info from environment
 */
app.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT) {
    serviceInfo.environment = c.env.ENVIRONMENT;
  }
  await next();
});

/**
 * Error handling middleware
 */
app.onError((err, c) => {
  console.error(`Error: ${err.message}`);
  
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    }
  };
  
  return c.json(response, 500);
});

/**
 * Not found handler
 */
app.notFound((c) => {
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found'
    }
  };
  
  return c.json(response, 404);
});

/**
 * Routes
 */
app.get('/', (c) => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: 'Hello World from Communicator Ingestor Service!',
      service: serviceInfo
    }
  };
  
  return c.json(response);
});

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * Initialize Telegram integration
 */
app.use('*', async (c, next) => {
  try {
    // Get Telegram config from environment
    const telegramConfig = getTelegramConfig(c.env);
    
    // Initialize Telegram auth client with service binding
    const telegramAuthClient = new TelegramAuthClient({
      telegramAuth: c.env.TELEGRAM_AUTH, // Use service binding
      serviceId: telegramConfig.serviceId,
      retryAttempts: telegramConfig.maxRetries,
      retryDelay: telegramConfig.retryDelay
    });
    
    // Initialize Telegram service
    const telegramService = new TelegramService({
      telegramApiId: telegramConfig.apiId,
      telegramApiHash: telegramConfig.apiHash,
      authClient: telegramAuthClient,
      maxRetries: telegramConfig.maxRetries,
      retryDelay: telegramConfig.retryDelay
    });
    
    // Initialize Telegram controller
    const telegramController = new TelegramController(telegramService);
    
    // Store in context for route handlers
    c.set('telegramController', telegramController);
  } catch (error) {
    console.warn('Failed to initialize Telegram integration:', error);
    // Continue without Telegram integration
  }
  
  await next();
});

/**
 * Telegram routes
 */
const telegramRouter = app.route('/api/telegram');

// Get messages from a Telegram channel or chat
telegramRouter.get('/messages/:userId/:source', async (c) => {
  const telegramController = c.get('telegramController');
  
  if (!telegramController) {
    return c.json({
      success: false,
      error: {
        code: 'TELEGRAM_NOT_CONFIGURED',
        message: 'Telegram integration is not configured'
      }
    }, 500);
  }
  
  return telegramController.getMessages(c);
});

// Get media from a Telegram channel or chat
telegramRouter.get('/media/:userId/:source', async (c) => {
  const telegramController = c.get('telegramController');
  
  if (!telegramController) {
    return c.json({
      success: false,
      error: {
        code: 'TELEGRAM_NOT_CONFIGURED',
        message: 'Telegram integration is not configured'
      }
    }, 500);
  }
  
  return telegramController.getMedia(c);
});

// Get information about a Telegram channel or chat
telegramRouter.get('/source/:userId/:source', async (c) => {
  const telegramController = c.get('telegramController');
  
  if (!telegramController) {
    return c.json({
      success: false,
      error: {
        code: 'TELEGRAM_NOT_CONFIGURED',
        message: 'Telegram integration is not configured'
      }
    }, 500);
  }
  
  return telegramController.getSourceInfo(c);
});

/**
 * Export the Hono app as the default export
 */
export default app;


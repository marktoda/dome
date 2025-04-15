import { ApiServer } from './api/server';
import { logger } from './utils/logger';
import { redisService } from './storage/redis';
import { SERVER, validateConfig, getSanitizedConfig } from './config';
import { initializeTelegramClientPool } from './telegram';
import { clientPool } from './telegram/clientPool';

/**
 * Application entry point
 * Initializes the application and starts the server
 */
async function bootstrap() {
  try {
    // Validate required configuration
    validateConfig();
    
    // Log configuration (excluding sensitive values)
    logger.info('Starting Telegram Proxy Service with configuration:', getSanitizedConfig());
    
    // Initialize Redis connection
    await redisService.connect();
    logger.info('Redis connection established');

    // Initialize Telegram client pool
    await initializeTelegramClientPool();
    logger.info('Telegram client pool initialized');

    // Create and start the API server
    const apiServer = new ApiServer();
    await apiServer.start();
    logger.info(`Telegram Proxy Service running at http://${SERVER.HOST}:${SERVER.PORT}`);
    logger.info(`Environment: ${SERVER.NODE_ENV}`);

    // Handle graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down server...');
      
      try {
        // Shutdown Telegram client pool
        logger.info('Shutting down Telegram client pool...');
        await clientPool.shutdown();
        logger.info('Telegram client pool shut down');
        
        // Disconnect Redis
        logger.info('Disconnecting from Redis...');
        await redisService.disconnect();
        logger.info('Redis disconnected');
        
        // Stop the API server
        logger.info('Stopping API server...');
        await apiServer.stop();
        logger.info('API server stopped');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Set up global error handlers for uncaught exceptions and unhandled rejections
// Note: These are also set up in the logger module, but we include them here as well
// to ensure they're registered even if the logger module is modified
if (process.env.NODE_ENV !== 'test') {
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
    console.error(error.name, error.message);
    console.error(error.stack);
    
    // Exit with error
    process.exit(1);
  });

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION! 💥 Unhandled Promise rejection:');
    console.error(reason);
    
    // In production, we might want to exit on unhandled rejections
    if (SERVER.IS_PRODUCTION) {
      process.exit(1);
    }
  });
}

// Start the application
bootstrap();
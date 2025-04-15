import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import http from 'http';
import { RATE_LIMIT, SERVER } from '../config';
import { logger, logStream } from '../utils/logger';
import { validateConfig } from '../config';
import { setupRoutes } from './routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { apiRateLimiter, rateLimitBypass } from './middleware/rateLimit';

/**
 * API Server class
 * Manages the Express.js server setup, configuration, and lifecycle
 */
export class ApiServer {
  private app: Express;
  private server: http.Server | null = null;
  private isShuttingDown = false;

  /**
   * Create a new API server instance
   * @param dependencies Optional dependencies for testing
   */
  constructor() {
    // Create Express app
    this.app = express();
    
    // Validate required configuration
    try {
      validateConfig();
    } catch (error) {
      logger.error('Configuration validation failed:', error);
      throw error;
    }
  }

  /**
   * Set up middleware for the Express app
   */
  public setupMiddleware(): void {
    // Apply security middleware
    this.app.use(helmet()); // Security headers
    this.app.use(cors()); // CORS support
    
    // Request parsing middleware
    this.app.use(express.json()); // Parse JSON request bodies
    this.app.use(express.urlencoded({ extended: true })); // Parse URL-encoded request bodies

    // Request logging middleware
    this.app.use(requestLogger); // Custom request logger with request ID tracking
    
    // HTTP request logging (for access logs)
    if (!SERVER.IS_TEST) {
      this.app.use(
        morgan(SERVER.IS_PRODUCTION ? 'combined' : 'dev', {
          stream: logStream,
          skip: (req) => req.url.includes('/api/v1/health'), // Skip health check logs
        })
      );
    }

    // Rate limiting middleware
    this.app.use(rateLimitBypass); // Check for rate limit bypass
    this.app.use(apiRateLimiter); // Apply rate limiting
  }

  /**
   * Set up routes for the Express app
   */
  public setupRoutes(): void {
    // Set up API routes
    setupRoutes(this.app);

    // 404 handler for undefined routes
    this.app.use(notFoundHandler);

    // Error handling middleware (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Start the server
   * @param port Port to listen on (defaults to config)
   * @param host Host to bind to (defaults to config)
   * @returns Promise that resolves when server is listening
   */
  public async start(port = SERVER.PORT, host = SERVER.HOST): Promise<void> {
    return new Promise((resolve) => {
      // Setup middleware and routes if not already done
      if (!this.server) {
        this.setupMiddleware();
        this.setupRoutes();
      }

      // Create HTTP server
      this.server = http.createServer(this.app);

      // Handle server errors
      this.server.on('error', (error) => {
        logger.error('Server error:', error);
      });

      // Start listening
      this.server.listen(port, host, () => {
        logger.info(`Server listening on http://${host}:${port}`);
        resolve();
      });

      // Setup graceful shutdown
      this.setupGracefulShutdown();
    });
  }

  /**
   * Stop the server gracefully
   * @returns Promise that resolves when server has stopped
   */
  public async stop(): Promise<void> {
    if (!this.server) {
      logger.info('Server is not running');
      return Promise.resolve();
    }

    if (this.isShuttingDown) {
      logger.info('Server is already shutting down');
      return Promise.resolve();
    }

    this.isShuttingDown = true;
    logger.info('Stopping server...');

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          logger.error('Error stopping server:', err);
          reject(err);
        } else {
          logger.info('Server stopped');
          this.server = null;
          this.isShuttingDown = false;
          resolve();
        }
      });

      // Force close after timeout
      setTimeout(() => {
        if (this.server) {
          logger.warn('Forcing server shutdown after timeout');
          this.server = null;
          this.isShuttingDown = false;
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * Get the Express app instance
   * Useful for testing
   */
  public getApp(): Express {
    return this.app;
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    // Handle process termination signals
    const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
    
    signals.forEach((signal) => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, shutting down gracefully`);
        
        try {
          await this.stop();
          process.exit(0);
        } catch (error) {
          logger.error('Error during graceful shutdown:', error);
          process.exit(1);
        }
      });
    });
  }
}

/**
 * Create and configure Express server (legacy function)
 * @deprecated Use ApiServer class instead
 */
export function createServer(): Express {
  const apiServer = new ApiServer();
  apiServer.setupMiddleware();
  apiServer.setupRoutes();
  return apiServer.getApp();
}
import type { Express } from 'express';
import { NotFoundError } from '../utils/errors';

// Import route modules
import authRoutes from './routes/auth';
import sessionsRoutes from './routes/sessions';
import messagesRoutes from './routes/messages';
import healthRoutes from './routes/health';

/**
 * Set up all routes for the application
 * This function registers all API routes with the Express app
 */
export function setupRoutes(app: Express): void {
  // API version prefix
  const apiPrefix = '/api/v1';

  // Register route modules
  app.use(`${apiPrefix}/auth`, authRoutes);
  app.use(`${apiPrefix}/sessions`, sessionsRoutes);
  app.use(`${apiPrefix}/messages`, messagesRoutes);
  app.use(`${apiPrefix}/health`, healthRoutes);

  // Catch-all for undefined routes
  app.use('*', (req, res, next) => {
    next(new NotFoundError(`Route not found: ${req.originalUrl}`));
  });
}

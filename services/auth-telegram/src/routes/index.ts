/**
 * Routes index
 */
import { Hono } from 'hono';
import authRoutes from './auth';
import sessionsRoutes from './sessions';

/**
 * Environment bindings type
 */
type Bindings = {
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  SESSION_SECRET: string;
  DB: D1Database;
  API_KEY: string;
  ADMIN_API_KEY: string;
};

/**
 * Create router
 */
const router = new Hono<{ Bindings: Bindings }>();

/**
 * Mount routes
 */
router.route('/', authRoutes);
router.route('/sessions', sessionsRoutes);

export default router;
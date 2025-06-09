import { trpcServer } from '@hono/trpc-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import { appRouter } from '../trpc/router.js';

import type { AppRouter } from '../trpc/router.js';

export type ApiRouter = AppRouter;

const app = new Hono();

// Add security headers
app.use('*', secureHeaders());

// Add CORS
app.use(
  '*',
  cors({
    origin: ['http://localhost:3000', 'http://localhost:5173'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Add logging
app.use('*', logger());

// Pretty JSON responses in development
if (process.env.NODE_ENV !== 'production') {
  app.use('*', prettyJSON());
}

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'dome2-api',
  });
});

// Mount tRPC router
app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
    createContext: (opts) => ({
      req: opts.req,
      // Add any additional context here (auth, db, etc.)
    }),
  })
);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Server error:', err);

  if (err.message.includes('validation')) {
    return c.json({ error: 'Validation error', details: err.message }, 400);
  }

  return c.json({ error: 'Internal Server Error' }, 500);
});

export { app };

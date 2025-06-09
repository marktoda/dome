#!/usr/bin/env node

import { serve } from '@hono/node-server';

import { app } from './hono/server.js';

const port = Number(process.env['PORT']) || 3001;
const host = process.env['HOST'] || '0.0.0.0';

console.log(`🚀 Server starting on http://${host}:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: host,
});

console.log(`✅ Server running on http://${host}:${port}`);

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { ServiceInfo } from '@dome/common';
import {
  createRequestContextMiddleware,
  createErrorMiddleware,
  responseHandlerMiddleware,
  createPinoLoggerMiddleware,
} from '@dome/common';
import { MessageController } from './controllers/messageController';
import type { PublishTelegramMessageRequest, TelegramMessageData } from './models';
import { formatZodError, telegramMessageBatchSchema, TelegramMessage } from './models';
import type { Bindings } from './types';

// Service information
const serviceInfo: ServiceInfo = {
  name: 'dome-api',
  version: '0.1.0',
  environment: 'development',
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Register middleware
app.use('*', createRequestContextMiddleware());
app.use('*', createPinoLoggerMiddleware());
app.use('*', cors());
app.use('*', createErrorMiddleware(formatZodError));
app.use('*', responseHandlerMiddleware);

// Routes
app.get('/', (c: any) =>
  c.json({
    message: 'Hello from dome-api service!',
    service: serviceInfo,
    description:
      'API service for the dome project',
  }),
);

// Message routes
app.post(
  '/publish/telegram/messages',
  zValidator('json', telegramMessageBatchSchema),
  async (c: any) => {
    // Get the validated data from zValidator
    const validatedData: PublishTelegramMessageRequest = c.req.valid('json');
    const messages = validatedData.messages.map(
      (message: TelegramMessageData) => new TelegramMessage(message),
    );

    // Process the request
    const messageController = new MessageController(c.env.EVENTS);
    const result = await messageController.publishTelegramMessages(messages);

    // Return the result as a JSON response
    return c.json(result);
  },
);

// Health check endpoint
app.get('/health', (c: any) =>
  c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: serviceInfo.name,
    version: serviceInfo.version,
  }),
);

export default app;

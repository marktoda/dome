import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { ApiResponse, ServiceInfo } from "@communicator/common";
import { MessageController } from "./controllers/messageController";
import { telegramMessageBatchSchema } from "./models/schemas";
import { Bindings } from "./types";

// Service information
const serviceInfo: ServiceInfo = {
  name: "push-message-ingestor",
  version: "0.1.0",
  environment: "development"
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Routes
app.get("/", (c: any) => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: "Hello from push-message-ingestor service!",
      service: serviceInfo,
      description: "Service for ingesting messages from various platforms and publishing them to a queue"
    }
  };

  return c.json(response);
});

// Message routes
app.post(
  "/publish/telegram/messages",
  zValidator('json', telegramMessageBatchSchema),
  async (c: any) => {
    try {
      // Get the validated data from zValidator
      const validatedData = c.req.valid('json');
      
      // Process the request
      const messageController = new MessageController(c.env.RAW_MESSAGES_QUEUE);
      return await messageController.publishTelegramMessages(validatedData);
    } catch (error) {
      // Handle unexpected errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      return c.json({
        success: false,
        error: {
          code: 'SERVER_ERROR',
          message: `Error processing request: ${errorMessage}`
        }
      }, 500);
    }
  }
);

// Health check endpoint
app.get("/health", (c: any) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: serviceInfo.name,
    version: serviceInfo.version
  });
});

export default app;

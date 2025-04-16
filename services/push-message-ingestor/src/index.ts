import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { ServiceInfo } from "@communicator/common";
import { MessageController } from "./controllers/messageController";
import { telegramMessageBatchSchema } from "./models/schemas";
import { pinoLogger } from "./middleware/pinoLogger";
import { createRequestContextMiddleware } from "./middleware/requestContext";
import { errorMiddleware } from "./middleware/errorMiddleware";
import { responseHandlerMiddleware } from "./middleware/responseHandlerMiddleware";
import { Bindings } from "./types";

// Service information
const serviceInfo: ServiceInfo = {
  name: "push-message-ingestor",
  version: "0.1.0",
  environment: "development"
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Register middleware
app.use("*", createRequestContextMiddleware());
app.use("*", pinoLogger());
app.use("*", cors());
app.use("*", errorMiddleware);
app.use("*", responseHandlerMiddleware);

// Routes
app.get("/", (c: any) => {
  return c.json({
    message: "Hello from push-message-ingestor service!",
    service: serviceInfo,
    description: "Service for ingesting messages from various platforms and publishing them to a queue"
  });
});

// Message routes
app.post(
  "/publish/telegram/messages",
  zValidator('json', telegramMessageBatchSchema),
  async (c: any) => {
    // Get the validated data from zValidator
    const validatedData = c.req.valid('json');

    // Process the request
    const messageController = new MessageController(c.env.RAW_MESSAGES_QUEUE);
    const result = await messageController.publishTelegramMessages(validatedData);

    // Return the result as a JSON response
    return c.json(result);
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

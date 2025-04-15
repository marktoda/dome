import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { ApiResponse, ServiceInfo } from "@communicator/common";

// Environment bindings
type Bindings = {
  ENVIRONMENT?: string;
};

// Service information
const serviceInfo: ServiceInfo = {
  name: "SERVICE_NAME",
  version: "0.1.0",
  environment: "development"
};

// Create Hono app
const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Routes
app.get("/", (c) => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: "Hello from SERVICE_NAME service!",
      service: serviceInfo
    }
  };
  
  return c.json(response);
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

export default app;
# Hono Framework Integration

This document provides detailed information about the integration of the [Hono](https://hono.dev/) framework in the Communicator Cloudflare project.

## Table of Contents

- [Hono Framework Integration](#hono-framework-integration)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Benefits of Hono](#benefits-of-hono)
  - [Implementation Details](#implementation-details)
    - [Integration with Cloudflare Workers](#integration-with-cloudflare-workers)
    - [Integration with Common Package](#integration-with-common-package)
  - [Worker Structure](#worker-structure)
  - [Middleware](#middleware)
    - [Logger Middleware](#logger-middleware)
    - [CORS Middleware](#cors-middleware)
    - [Custom Middleware](#custom-middleware)
  - [Type Safety](#type-safety)
    - [Environment Bindings](#environment-bindings)
    - [API Responses](#api-responses)
  - [Environment Variables](#environment-variables)
  - [Error Handling](#error-handling)
  - [Creating New Services](#creating-new-services)
  - [Migrating Existing Services](#migrating-existing-services)
  - [Best Practices](#best-practices)
    - [Route Organization](#route-organization)
    - [Error Handling](#error-handling-1)
    - [Middleware](#middleware-1)
    - [Testing](#testing)

## Introduction

Hono is a small, fast, and lightweight web framework for Cloudflare Workers and other edge runtimes. It provides a simple and intuitive API for building web applications with features like routing, middleware, and TypeScript support.

## Benefits of Hono

1. **Performance**: Hono is designed to be extremely fast and lightweight, making it ideal for edge computing environments like Cloudflare Workers.

2. **TypeScript-First**: Hono is built with TypeScript in mind, providing excellent type safety and developer experience.

3. **Middleware Support**: Hono includes a middleware system that makes it easy to add cross-cutting concerns like logging, authentication, and CORS.

4. **Routing**: Hono provides a simple and intuitive routing system that makes it easy to define API endpoints.

5. **Built-in Utilities**: Hono includes built-in utilities for common web tasks like parsing request bodies, handling cookies, and serving static files.

6. **Extensibility**: Hono is designed to be extensible, allowing you to add custom middleware and handlers as needed.

## Implementation Details

### Integration with Cloudflare Workers

Hono is designed to work seamlessly with Cloudflare Workers. It exports a default handler that can be used directly with the Cloudflare Workers runtime:

```typescript
import { Hono } from 'hono';

const app = new Hono();

app.get('/', c => c.text('Hello Cloudflare Workers!'));

export default app;
```

### Integration with Common Package

The Communicator project uses a common package for shared types and utilities. Hono integrates with this package to provide consistent API responses:

```typescript
import { Hono } from 'hono';
import { ApiResponse, ServiceInfo } from '@communicator/common';

const app = new Hono();

app.get('/', c => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: 'Hello World!',
    },
  };

  return c.json(response);
});
```

## Worker Structure

A typical Hono worker in the Communicator project has the following structure:

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { ApiResponse, ServiceInfo } from '@communicator/common';

/**
 * Environment bindings type
 */
type Bindings = {
  ENVIRONMENT?: string;
};

/**
 * Service information
 */
const serviceInfo: ServiceInfo = {
  name: 'service-name',
  version: '0.1.0',
  environment: 'development', // Default value, will be overridden by env
};

/**
 * Create Hono app
 */
const app = new Hono<{ Bindings: Bindings }>();

/**
 * Middleware
 */
app.use('*', logger());
app.use('*', cors());

/**
 * Middleware to set service info from environment
 */
app.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT) {
    serviceInfo.environment = c.env.ENVIRONMENT;
  }
  await next();
});

/**
 * Routes
 */
app.get('/', c => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: 'Hello World!',
      service: serviceInfo,
    },
  };

  return c.json(response);
});

/**
 * Health check endpoint
 */
app.get('/health', c => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Export the Hono app as the default export
 */
export default app;
```

## Middleware

Hono provides a middleware system that makes it easy to add cross-cutting concerns to your application. The Communicator project uses the following middleware:

### Logger Middleware

The logger middleware logs information about each request, including the method, path, status code, and response time:

```typescript
import { logger } from 'hono/logger';

app.use('*', logger());
```

### CORS Middleware

The CORS middleware adds Cross-Origin Resource Sharing headers to responses:

```typescript
import { cors } from 'hono/cors';

app.use('*', cors());
```

### Custom Middleware

Custom middleware can be added to handle project-specific concerns. For example, the Communicator project uses middleware to set the service environment from environment variables:

```typescript
app.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT) {
    serviceInfo.environment = c.env.ENVIRONMENT;
  }
  await next();
});
```

## Type Safety

Hono provides excellent type safety through TypeScript generics. The Communicator project uses the following type definitions:

### Environment Bindings

Environment bindings are defined using TypeScript interfaces:

```typescript
type Bindings = {
  ENVIRONMENT?: string;
};

const app = new Hono<{ Bindings: Bindings }>();
```

This allows you to access environment variables in a type-safe way:

```typescript
app.get('/env', c => {
  const environment = c.env.ENVIRONMENT || 'development';
  return c.text(`Environment: ${environment}`);
});
```

### API Responses

API responses are defined using the common package:

```typescript
import { ApiResponse } from '@communicator/common';

app.get('/', c => {
  const response: ApiResponse = {
    success: true,
    data: {
      message: 'Hello World!',
    },
  };

  return c.json(response);
});
```

## Environment Variables

Hono provides access to environment variables through the context object:

```typescript
app.get('/env', c => {
  const environment = c.env.ENVIRONMENT || 'development';
  return c.text(`Environment: ${environment}`);
});
```

Environment variables are defined in the `wrangler.toml` file:

```toml
[vars]
ENVIRONMENT = "development"

[env.production]
vars = { ENVIRONMENT = "production" }

[env.staging]
vars = { ENVIRONMENT = "staging" }
```

## Error Handling

Hono provides built-in error handling through the `onError` method:

```typescript
app.onError((err, c) => {
  console.error(`Error: ${err.message}`);

  const response: ApiResponse = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  };

  return c.json(response, 500);
});
```

For 404 errors, Hono provides the `notFound` method:

```typescript
app.notFound(c => {
  const response: ApiResponse = {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found',
    },
  };

  return c.json(response, 404);
});
```

## Creating New Services

The Communicator project provides a command to create new Hono-based services:

```bash
just new-hono-service my-service-name
```

This command creates a new service with the following structure:

```
services/my-service-name/
├── src/
│   └── index.ts              # Hono app
├── wrangler.toml             # Wrangler configuration
├── package.json              # Package configuration
└── tsconfig.json             # TypeScript configuration
```

The `index.ts` file contains a basic Hono app with middleware, routes, and error handling.

## Migrating Existing Services

The Communicator project provides a command to migrate existing services to use Hono:

```bash
just update-to-hono service-name
```

This command updates an existing service to use Hono by:

1. Adding Hono as a dependency
2. Backing up the original `index.ts` file
3. Creating a new `index.ts` file with a Hono app

## Best Practices

### Route Organization

For larger services, it's recommended to organize routes into separate files:

```
services/my-service/
├── src/
│   ├── index.ts              # Main Hono app
│   ├── routes/
│   │   ├── index.ts          # Route exports
│   │   ├── users.ts          # User routes
│   │   └── messages.ts       # Message routes
│   └── middleware/
│       ├── index.ts          # Middleware exports
│       ├── auth.ts           # Authentication middleware
│       └── logging.ts        # Logging middleware
├── wrangler.toml
├── package.json
└── tsconfig.json
```

Example route file:

```typescript
// src/routes/users.ts
import { Hono } from 'hono';
import { ApiResponse } from '@communicator/common';

const app = new Hono();

app.get('/', c => {
  const response: ApiResponse = {
    success: true,
    data: {
      users: [],
    },
  };

  return c.json(response);
});

app.get('/:id', c => {
  const id = c.req.param('id');

  const response: ApiResponse = {
    success: true,
    data: {
      user: { id },
    },
  };

  return c.json(response);
});

export default app;
```

Main app file:

```typescript
// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import userRoutes from './routes/users';
import messageRoutes from './routes/messages';

const app = new Hono();

app.use('*', logger());
app.use('*', cors());

app.route('/users', userRoutes);
app.route('/messages', messageRoutes);

export default app;
```

### Error Handling

Use consistent error handling across all services:

```typescript
app.onError((err, c) => {
  console.error(`Error: ${err.message}`);

  const response: ApiResponse = {
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  };

  return c.json(response, 500);
});
```

### Middleware

Use middleware for cross-cutting concerns:

```typescript
// Authentication middleware
app.use('/api/*', async (c, next) => {
  const token = c.req.header('Authorization');

  if (!token) {
    const response: ApiResponse = {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      },
    };

    return c.json(response, 401);
  }

  // Validate token
  // ...

  await next();
});
```

### Testing

Use Hono's built-in testing utilities:

```typescript
import { describe, it, expect } from 'vitest';
import app from '../src/index';

describe('API', () => {
  it('should return 200 OK', async () => {
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
```

/**
 * @dome/errors Hono Middleware Examples
 *
 * This file demonstrates how to use @dome/errors with Hono web framework,
 * focusing on error handling middleware, response standardization, and
 * integration with the logging package.
 */

import { Hono } from 'hono';
import {
  errorHandler,
  ValidationError,
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  InternalError,
  ConflictError,
  RateLimitError,
  createErrorFactory,
  toDomeError,
  assertValid,
  assertExists
} from '../src';

// Import logging package integration
import { getLogger } from '@dome/common';

// -----------------------------------------------
// Basic App with Default Error Handler
// -----------------------------------------------

export function createBasicApp() {
  const app = new Hono();

  // Apply error handling middleware with default settings
  app.use('*', errorHandler());

  // Define routes
  app.get('/', c => {
    return c.json({ message: 'Hello World' });
  });

  // Route that throws a ValidationError
  app.post('/users', async c => {
    const data = await c.req.json();

    // Will be caught by error handler middleware
    if (!data.email) {
      throw new ValidationError('Email is required', { field: 'email' });
    }

    return c.json({ success: true, data });
  });

  // Route that throws a NotFoundError
  app.get('/users/:id', c => {
    const id = c.req.param('id');

    if (id === '999') {
      throw new NotFoundError(`User with ID ${id} not found`, { userId: id });
    }

    return c.json({ id, name: 'John Doe' });
  });

  // Route that throws an UnauthorizedError
  app.get('/protected', c => {
    const token = c.req.header('Authorization');

    if (!token) {
      throw new UnauthorizedError('Authentication required');
    }

    return c.json({ secretData: 'This is protected' });
  });

  return app;
}

// -----------------------------------------------
// Advanced App with Custom Error Handler Config
// -----------------------------------------------

export function createAdvancedApp() {
  const app = new Hono();

  // Setup custom error handler with advanced options
  app.use('*', errorHandler({
    // Include stack traces in non-production environments
    includeStack: true,

    // Include cause details in non-production environments
    includeCause: true,

    // Custom error mapping function
    errorMapper: (err: unknown) => {
      // Handle database-specific errors
      if (err instanceof Error && (err as any).code === 'P2002') {
        return new ConflictError(
          'Resource already exists',
          { constraint: (err as any).meta?.target },
          err
        );
      }

      // Handle axios errors
      if (err instanceof Error && (err as any).isAxiosError) {
        const axiosError = err as any;
        const status = axiosError.response?.status;

        if (status === 404) {
          return new NotFoundError('Resource not found in external service', {
            url: axiosError.config?.url
          }, err);
        }

        return new InternalError('External service error', {
          status,
          url: axiosError.config?.url
        }, err);
      }

      // Use default conversion for other errors
      return err instanceof Error && !(err instanceof Hono.HTTPException)
        ? toDomeError(err, 'An error occurred')
        : err;
    },

    // Custom logger retrieval
    getContextLogger: (c) => {
      try {
        return c.get('logger') || getLogger();
      } catch {
        return getLogger();
      }
    }
  }));

  // Add logging middleware (assuming @dome/common is set up)
  app.use('*', async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') || crypto.randomUUID());
    await next();
  });

  // Define routes
  app.get('/', c => {
    return c.json({ message: 'Advanced error handling example' });
  });

  // Route demonstrating rate limit errors
  app.get('/rate-limited', c => {
    const clientIp = c.req.header('x-forwarded-for') || '127.0.0.1';

    // Simple rate limiting example
    if (Math.random() > 0.7) {
      throw new RateLimitError('Too many requests', {
        retryAfter: 60,
        limit: 100,
        clientIp
      });
    }

    return c.json({ message: 'Rate limit not exceeded' });
  });

  // Route demonstrating error from async operation
  app.get('/async-error', async c => {
    // This simulates a database or external service error
    const result = await simulateAsyncOperation();
    return c.json({ result });
  });

  return app;
}

// -----------------------------------------------
// Domain-Specific Error Handling
// -----------------------------------------------

export function createDomainApp() {
  const app = new Hono();

  // Apply standard error handler
  app.use('*', errorHandler());

  // Create domain-specific error factories
  const userErrors = createErrorFactory('UserService', { component: 'api' });
  const productErrors = createErrorFactory('ProductService', { component: 'api' });

  // User routes with domain-specific errors
  app.post('/users', async c => {
    try {
      const data = await c.req.json();

      // Using domain assertion helper
      userErrors.assertValid(data.email, 'Email is required', { field: 'email' });
      userErrors.assertValid(
        typeof data.age === 'number' && data.age >= 18,
        'Age must be at least 18',
        { field: 'age', value: data.age, minValue: 18 }
      );

      return c.json({ success: true });
    } catch (error) {
      // All errors will already be properly formatted UserService errors
      throw error;
    }
  });

  // Product routes with domain-specific errors and wrapped operations
  app.get('/products/:id', async c => {
    const id = c.req.param('id');

    // Using error wrapper from factory
    const product = await productErrors.wrap(
      async () => {
        if (id === 'invalid') {
          throw new Error('Invalid product ID format');
        }

        const product = await findProduct(id);

        if (!product) {
          throw productErrors.notFound(`Product with ID ${id} not found`);
        }

        if (product.status === 'discontinued') {
          throw productErrors.badRequest('Product is discontinued', {
            productId: id,
            status: 'discontinued',
            discontinuedAt: product.discontinuedAt
          });
        }

        return product;
      },
      'Failed to retrieve product', // Default message
      { productId: id } // Context for all errors
    );

    return c.json({ product });
  });

  return app;
}

// -----------------------------------------------
// Combined Logging and Error Handling
// -----------------------------------------------

export function createIntegratedApp() {
  const app = new Hono();

  // Setup request context
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') || crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    await next();
  });

  // Add error handling that integrates with logging
  app.use('*', async (c, next) => {
    try {
      await next();
    } catch (error) {
      const logger = getLogger();
      const requestId = c.get('requestId');

      // Convert to DomeError if needed
      const domeError = error instanceof Error && !(error instanceof Hono.HTTPException)
        ? toDomeError(error, 'Request processing failed')
        : error;

      // Log the error with full details
      logger.error({
        event: 'request_error',
        error: domeError instanceof Error ? domeError : String(domeError),
        requestId,
        path: c.req.path,
        method: c.req.method
      });

      // Generate appropriate response
      if (domeError instanceof Error && 'statusCode' in domeError && 'code' in domeError) {
        const statusCode = (domeError as any).statusCode || 500;

        return c.json({
          error: {
            code: (domeError as any).code || 'INTERNAL_ERROR',
            message: domeError.message,
            details: (domeError as any).details,
            requestId
          }
        }, statusCode);
      }

      // Fallback for non-DomeErrors
      return c.json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
          requestId
        }
      }, 500);
    }
  });

  // Define routes
  app.get('/', c => {
    return c.json({ message: 'Integrated logging and error handling' });
  });

  app.get('/error', c => {
    throw new InternalError('Test error', { test: true });
  });

  return app;
}

// -----------------------------------------------
// Helper functions
// -----------------------------------------------

async function simulateAsyncOperation(): Promise<any> {
  // Simulate random error
  await new Promise(resolve => setTimeout(resolve, 100));

  if (Math.random() > 0.7) {
    const error = new Error('Database connection failed');
    (error as any).code = 'CONNECTION_ERROR';
    throw error;
  }

  return { success: true, data: { items: [1, 2, 3] } };
}

async function findProduct(id: string): Promise<any | null> {
  // Simulate product lookup
  await new Promise(resolve => setTimeout(resolve, 50));

  if (id === '404') {
    return null;
  }

  return {
    id,
    name: `Product ${id}`,
    price: 99.99,
    status: id === 'discontinued' ? 'discontinued' : 'active',
    discontinuedAt: id === 'discontinued' ? new Date().toISOString() : null
  };
}

// -----------------------------------------------
// Example usage
// -----------------------------------------------

// You can run these examples with:
//
// const app = createBasicApp();
// export default app;
//
// Or:
//
// const app = createAdvancedApp();
// export default app;
//
// Or:
//
// const app = createDomainApp();
// export default app;
//
// Or:
//
// const app = createIntegratedApp();
// export default app;

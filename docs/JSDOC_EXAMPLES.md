# JSDoc Documentation Examples

> **Version:** 1.0.0  
> **Package:** `@dome/common`  
> **Stack:** TypeScript 5

## 1. Overview

This document provides examples of proper JSDoc documentation for the key functions and classes in the `@dome/common` package. These examples can be used as a reference when adding or updating documentation in the codebase.

## 2. Context Module

### 2.1 withContext Function

````typescript
/**
 * Runs a function with a specific context using AsyncLocalStorage.
 * This allows context to be propagated through async operations without passing it explicitly.
 *
 * @param meta - Metadata to include in the context and logger
 * @param meta.level - Optional logging level for the child logger
 * @param meta.identity - Optional user identity information
 * @param fn - The function to execute within the context
 * @returns The result of the function execution
 *
 * @example
 * ```typescript
 * const result = await withContext(
 *   { requestId: '123', userId: '456', operation: 'processData' },
 *   async (logger) => {
 *     logger.info('Processing data');
 *     return await processData();
 *   }
 * );
 * ```
 */
export async function withContext<T>(meta: Meta, fn: (log: Logger) => Promise<T> | T): Promise<T> {
  // Implementation
}
````

### 2.2 Context Accessor Functions

````typescript
/**
 * Gets the current user identity from the context if available.
 * Returns undefined if no identity is set or if called outside a context.
 *
 * @returns The current user identity or undefined
 *
 * @example
 * ```typescript
 * const identity = getIdentity();
 * if (identity) {
 *   console.log(`User: ${identity.email}`);
 * }
 * ```
 */
export const getIdentity: () => Identity | undefined = () => ctxStore.getStore()?.identity;

/**
 * Gets the context-aware logger instance.
 * If called outside a context, returns the base logger.
 *
 * @returns A logger instance with the current context
 *
 * @example
 * ```typescript
 * const logger = getLogger();
 * logger.info({ userId }, 'User logged in');
 * ```
 */
export const getLogger: () => Logger = () => ctxStore.getStore()?.logger ?? baseLogger;

/**
 * Gets the current request ID from the context if available.
 * Returns undefined if no request ID is set or if called outside a context.
 *
 * @returns The current request ID or undefined
 *
 * @example
 * ```typescript
 * const requestId = getRequestId();
 * console.log(`Processing request: ${requestId}`);
 * ```
 */
export const getRequestId: () => string | undefined = () => ctxStore.getStore()?.requestId;
````

## 3. Error Handling Module

### 3.1 Error Factory Function

````typescript
/**
 * Creates a factory for domain-specific error classes.
 * This allows services to create their own error types with consistent behavior.
 *
 * @param domain - The domain name for the errors (e.g., 'auth', 'storage')
 * @param defaultDetails - Default details to include in all errors created by this factory
 * @returns An object with factory methods for creating different error types
 *
 * @example
 * ```typescript
 * const AuthErrors = createErrorFactory('auth', { service: 'auth-service' });
 *
 * // Create a validation error
 * throw new AuthErrors.ValidationError('Invalid email format', { field: 'email' });
 *
 * // Create a not found error
 * throw new AuthErrors.NotFoundError('User not found', { userId });
 * ```
 */
export function createErrorFactory(domain: string, defaultDetails: Record<string, any> = {}) {
  // Implementation
}
````

### 3.2 Error Middleware

````typescript
/**
 * Creates an error handling middleware for Hono applications.
 * This middleware catches errors, formats them into standardized responses,
 * and handles different error types appropriately.
 *
 * @param formatZodError - Optional function to format Zod validation errors
 * @returns A middleware handler for error handling
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createErrorMiddleware } from '@dome/common';
 *
 * const app = new Hono();
 *
 * // Add error handling middleware
 * app.use('*', createErrorMiddleware());
 *
 * // Or with custom Zod error formatting
 * app.use('*', createErrorMiddleware((error) => {
 *   return error.errors.map(err => ({
 *     path: err.path.join('.'),
 *     message: err.message
 *   }));
 * }));
 * ```
 */
export function createErrorMiddleware(
  formatZodError?: (error: ZodError) => any,
): MiddlewareHandler {
  // Implementation
}
````

## 4. Logging Module

### 4.1 Error Logging Functions

````typescript
/**
 * Extracts detailed error information for structured logging.
 * This function handles different error types and extracts relevant properties.
 *
 * @param error - The error object to extract information from
 * @returns An object with error details including message, name, code, stack, etc.
 *
 * @example
 * ```typescript
 * try {
 *   // Operation that might throw
 * } catch (error) {
 *   const errorInfo = extractErrorInfo(error);
 *   console.log(errorInfo);
 * }
 * ```
 */
export function extractErrorInfo(error: unknown): {
  error: unknown;
  errorMessage: string;
  errorName?: string;
  errorCode?: string;
  errorStack?: string;
  statusCode?: number;
  details?: Record<string, any>;
  cause?: unknown;
} {
  // Implementation
}

/**
 * Enhanced error logging that properly extracts and includes error information.
 * This function should be used instead of directly logging errors.
 *
 * @param error - The error object to log
 * @param message - The log message describing what happened
 * @param additionalContext - Additional context to include in the log
 *
 * @example
 * ```typescript
 * try {
 *   await processData(data);
 * } catch (error) {
 *   logError(error, 'Failed to process data', { dataId: data.id });
 *   throw error; // Rethrow if needed
 * }
 * ```
 */
export function logError(
  error: unknown,
  message: string,
  additionalContext: Record<string, unknown> = {},
): void {
  // Implementation
}
````

### 4.2 Operation Tracking

````typescript
/**
 * Wraps an asynchronous operation with standardized start/success/error logging.
 * This function automatically logs the start, success, or failure of an operation
 * along with timing information.
 *
 * @param operationName - Name of the operation to track
 * @param fn - The async function to execute
 * @param context - Additional context to include in logs
 * @returns The result of the async function
 *
 * @example
 * ```typescript
 * const result = await trackOperation(
 *   'processPayment',
 *   async () => {
 *     // Payment processing code
 *     return paymentResult;
 *   },
 *   { userId, amount, currency }
 * );
 * ```
 */
export async function trackOperation<T>(
  operationName: string,
  fn: () => Promise<T>,
  context: Record<string, any> = {},
): Promise<T> {
  // Implementation
}
````

## 5. Function Wrappers

### 5.1 Service Wrapper

````typescript
/**
 * Creates a service-specific wrapper that provides consistent error handling,
 * logging, and context propagation for service functions.
 *
 * @param serviceName - The name of the service for logging and error context
 * @returns A function that wraps service operations with error handling and logging
 *
 * @example
 * ```typescript
 * const wrap = createServiceWrapper('auth-service');
 *
 * async function authenticateUser(credentials) {
 *   return wrap(
 *     { operation: 'authenticateUser', userId: credentials.userId },
 *     async () => {
 *       // Implementation with automatic error handling
 *     }
 *   );
 * }
 * ```
 */
export function createServiceWrapper(serviceName: string) {
  // Implementation
}
````

### 5.2 Process Chain

````typescript
/**
 * Creates a processing chain that breaks down complex operations into
 * discrete steps with proper validation and error handling.
 *
 * @param options - Configuration options
 * @param options.serviceName - The name of the service
 * @param options.operation - The operation name for logging
 * @param options.inputValidation - Optional function to validate inputs
 * @param options.process - The main processing function
 * @param options.outputValidation - Optional function to validate outputs
 * @returns A function that chains all the steps with proper error handling
 *
 * @example
 * ```typescript
 * const processUserRegistration = createProcessChain({
 *   serviceName: 'user-service',
 *   operation: 'registerUser',
 *
 *   inputValidation: (input) => {
 *     assertValid(input.email, 'Email is required');
 *   },
 *
 *   process: async (input) => {
 *     // Implementation
 *     return createdUser;
 *   },
 *
 *   outputValidation: (output) => {
 *     assertValid(output.id, 'User ID is missing');
 *   }
 * });
 * ```
 */
export function createProcessChain<TInput, TOutput>(options: {
  serviceName: string;
  operation: string;
  inputValidation?: (input: TInput) => void;
  process: (input: TInput) => Promise<TOutput>;
  outputValidation?: (output: TOutput) => void;
}) {
  // Implementation
}
````

## 6. Middleware

### 6.1 Request Context Middleware

````typescript
/**
 * Creates middleware for setting up request context in Hono applications.
 * This middleware extracts or generates a request ID and makes it available
 * throughout the request lifecycle.
 *
 * @param requestIdHeader - The header to use for the request ID (default: X-Request-ID)
 * @returns A middleware function that sets up the request context
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createRequestContextMiddleware } from '@dome/common';
 *
 * const app = new Hono();
 *
 * // Add request context middleware
 * app.use('*', createRequestContextMiddleware());
 *
 * // Or with a custom header
 * app.use('*', createRequestContextMiddleware('X-Correlation-ID'));
 * ```
 */
export function createRequestContextMiddleware(
  requestIdHeader = 'X-Request-ID',
): (c: Context, next: Next) => Promise<void> {
  // Implementation
}
````

## 7. Best Practices for JSDoc Documentation

### 7.1 General Guidelines

1. **Document All Exports**: Every exported function, class, interface, and type should have JSDoc comments.
2. **Include Examples**: Provide usage examples for complex functions.
3. **Be Specific**: Use specific types in parameter and return descriptions.
4. **Document Parameters**: Document all parameters, including optional ones.
5. **Document Return Values**: Clearly describe what the function returns.
6. **Document Exceptions**: If a function can throw exceptions, document them.
7. **Use Markdown**: JSDoc supports Markdown for formatting.

### 7.2 JSDoc Tags

- `@param` - Documents a function parameter
- `@returns` - Documents the return value
- `@throws` - Documents exceptions that might be thrown
- `@example` - Provides usage examples
- `@deprecated` - Marks a function as deprecated
- `@see` - References related documentation
- `@since` - Indicates when the function was added
- `@todo` - Indicates planned changes

### 7.3 Example Template

````typescript
/**
 * Brief description of what the function does.
 * More detailed explanation if needed.
 *
 * @param paramName - Description of the parameter
 * @param [optionalParam] - Description of the optional parameter
 * @returns Description of the return value
 * @throws {ErrorType} Description of when this error is thrown
 *
 * @example
 * ```typescript
 * // Example usage
 * const result = myFunction('value');
 * ```
 *
 * @see OtherRelatedFunction
 * @since 1.0.0
 */
````

## 8. Conclusion

Proper JSDoc documentation is essential for maintaining a high-quality codebase. It helps developers understand how to use functions correctly, makes code more discoverable, and improves the development experience with better IDE integration.

By following these examples and best practices, you can ensure that all code in the `@dome/common` package is well-documented and easy to use.

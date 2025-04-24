/**
 * Custom error for validation failures
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Custom error for queue operations
 */
export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueError';
  }
}

/**
 * Custom error for persistence operations
 */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

/**
 * Custom error for notification operations
 */
export class NotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationError';
  }
}

/**
 * Custom error for authorization failures
 */
export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * Custom error for resource not found
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Determine error type from error object
 * @param error The error object
 * @returns Error type string
 */
export function determineErrorType(error: unknown): string {
  if (error instanceof ValidationError) {
    return 'validation_error';
  } else if (error instanceof QueueError) {
    return 'queue_error';
  } else if (error instanceof PersistenceError) {
    return 'persistence_error';
  } else if (error instanceof NotificationError) {
    return 'notification_error';
  } else if (error instanceof AuthorizationError) {
    return 'authorization_error';
  } else if (error instanceof NotFoundError) {
    return 'not_found_error';
  } else {
    return 'internal_error';
  }
}
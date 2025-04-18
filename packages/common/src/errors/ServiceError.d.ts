import { BaseError } from './BaseError';
/**
 * Error class for service-related errors
 */
export declare class ServiceError extends BaseError {
    /**
     * Creates a new ServiceError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for queue-related errors
 */
export declare class QueueError extends ServiceError {
    /**
     * Creates a new QueueError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for message processing errors
 */
export declare class MessageProcessingError extends ServiceError {
    /**
     * Creates a new MessageProcessingError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for rate limit errors
 */
export declare class RateLimitError extends ServiceError {
    /**
     * Creates a new RateLimitError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for resource not found errors
 */
export declare class NotFoundError extends ServiceError {
    /**
     * Creates a new NotFoundError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message: string, details?: Record<string, any>);
}
/**
 * Error class for unauthorized access
 */
export declare class UnauthorizedError extends ServiceError {
    /**
     * Creates a new UnauthorizedError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message?: string, details?: Record<string, any>);
}
/**
 * Error class for forbidden access
 */
export declare class ForbiddenError extends ServiceError {
    /**
     * Creates a new ForbiddenError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message?: string, details?: Record<string, any>);
}
/**
 * Error class for not implemented functionality
 */
export declare class NotImplementedError extends ServiceError {
    /**
     * Creates a new NotImplementedError
     * @param message Error message
     * @param details Additional error details
     */
    constructor(message?: string, details?: Record<string, any>);
}

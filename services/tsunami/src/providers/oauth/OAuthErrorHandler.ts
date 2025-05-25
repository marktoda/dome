/**
 * OAuth Error Handler
 * 
 * Standardized error handling for OAuth operations across all providers.
 * Provides consistent error messages and logging patterns.
 */
import { getLogger } from '@dome/common';
import { ServiceError } from '@dome/common/errors';

/**
 * OAuth-specific error types
 */
export enum OAuthErrorType {
  INVALID_REQUEST = 'invalid_request',
  INVALID_CLIENT = 'invalid_client',
  INVALID_GRANT = 'invalid_grant',
  UNAUTHORIZED_CLIENT = 'unauthorized_client',
  UNSUPPORTED_GRANT_TYPE = 'unsupported_grant_type',
  INVALID_SCOPE = 'invalid_scope',
  ACCESS_DENIED = 'access_denied',
  NETWORK_ERROR = 'network_error',
  TIMEOUT = 'timeout',
  UNKNOWN = 'unknown',
}

/**
 * OAuth error details
 */
export interface OAuthErrorDetails {
  type: OAuthErrorType;
  message: string;
  description?: string;
  platform: string;
  operation: 'authorize' | 'token_exchange' | 'token_refresh' | 'revoke';
  httpStatus?: number;
  originalError?: Error;
  context?: Record<string, any>;
}

/**
 * User-friendly error messages for different OAuth error types
 */
const USER_FRIENDLY_MESSAGES: Record<OAuthErrorType, string> = {
  [OAuthErrorType.INVALID_REQUEST]: 'Invalid request parameters. Please try again.',
  [OAuthErrorType.INVALID_CLIENT]: 'Application configuration error. Please contact support.',
  [OAuthErrorType.INVALID_GRANT]: 'Authorization code expired. Please try connecting again.',
  [OAuthErrorType.UNAUTHORIZED_CLIENT]: 'Application not authorized. Please contact support.',
  [OAuthErrorType.UNSUPPORTED_GRANT_TYPE]: 'Authorization method not supported.',
  [OAuthErrorType.INVALID_SCOPE]: 'Requested permissions not available.',
  [OAuthErrorType.ACCESS_DENIED]: 'Access was denied. Please grant permission to continue.',
  [OAuthErrorType.NETWORK_ERROR]: 'Network error occurred. Please check your connection and try again.',
  [OAuthErrorType.TIMEOUT]: 'Request timed out. Please try again.',
  [OAuthErrorType.UNKNOWN]: 'An unexpected error occurred. Please try again.',
};

/**
 * OAuth Error class with enhanced error information
 */
export class OAuthError extends ServiceError {
  public readonly errorType: OAuthErrorType;
  public readonly platform: string;
  public readonly operation: string;
  public readonly httpStatus?: number;
  public readonly userMessage: string;

  constructor(details: OAuthErrorDetails) {
    super(details.message, {
      cause: details.originalError,
      context: {
        ...details.context,
        platform: details.platform,
        operation: details.operation,
        errorType: details.type,
        httpStatus: details.httpStatus,
      },
    });

    this.errorType = details.type;
    this.platform = details.platform;
    this.operation = details.operation;
    this.httpStatus = details.httpStatus;
    this.userMessage = USER_FRIENDLY_MESSAGES[details.type];
    this.name = 'OAuthError';
  }

  /**
   * Get a user-friendly error message
   */
  getUserMessage(): string {
    return this.userMessage;
  }

  /**
   * Get technical details for logging/debugging
   */
  getTechnicalDetails(): Record<string, any> {
    return {
      errorType: this.errorType,
      platform: this.platform,
      operation: this.operation,
      httpStatus: this.httpStatus,
      originalMessage: this.message,
      context: this.context,
    };
  }
}

/**
 * OAuth Error Handler utility class
 */
export class OAuthErrorHandler {
  private static readonly log = getLogger();

  /**
   * Parse an OAuth error response and create appropriate error object
   */
  static parseOAuthErrorResponse(
    response: Response,
    responseBody: any,
    platform: string,
    operation: OAuthErrorDetails['operation']
  ): OAuthError {
    let errorType = OAuthErrorType.UNKNOWN;
    let message = 'Unknown OAuth error';
    let description: string | undefined;

    // Try to parse standard OAuth error response
    if (responseBody && typeof responseBody === 'object') {
      const errorCode = responseBody.error || responseBody.error_code;
      const errorDescription = responseBody.error_description || responseBody.description;

      if (errorCode) {
        errorType = this.mapErrorCode(errorCode);
        message = errorDescription || errorCode;
        description = errorDescription;
      }
    }

    // Handle HTTP status codes
    if (response.status === 401) {
      errorType = OAuthErrorType.INVALID_CLIENT;
      message = 'Authentication failed';
    } else if (response.status === 403) {
      errorType = OAuthErrorType.ACCESS_DENIED;
      message = 'Access forbidden';
    } else if (response.status >= 500) {
      errorType = OAuthErrorType.NETWORK_ERROR;
      message = 'Server error occurred';
    }

    return new OAuthError({
      type: errorType,
      message,
      description,
      platform,
      operation,
      httpStatus: response.status,
      context: {
        url: response.url,
        responseBody,
      },
    });
  }

  /**
   * Create an OAuth error from a generic error
   */
  static createOAuthError(
    error: Error,
    platform: string,
    operation: OAuthErrorDetails['operation'],
    context?: Record<string, any>
  ): OAuthError {
    let errorType = OAuthErrorType.UNKNOWN;

    // Try to determine error type from error message
    if (error.message.includes('network') || error.message.includes('fetch')) {
      errorType = OAuthErrorType.NETWORK_ERROR;
    } else if (error.message.includes('timeout')) {
      errorType = OAuthErrorType.TIMEOUT;
    }

    return new OAuthError({
      type: errorType,
      message: error.message,
      platform,
      operation,
      originalError: error,
      context,
    });
  }

  /**
   * Log OAuth error with appropriate level and context
   */
  static logOAuthError(error: OAuthError): void {
    const logContext = {
      ...error.getTechnicalDetails(),
      userMessage: error.getUserMessage(),
    };

    // Use appropriate log level based on error type
    if (error.errorType === OAuthErrorType.ACCESS_DENIED) {
      // User denied access - this is normal, log as info
      this.log.info(logContext, 'oauth: user denied access');
    } else if (error.errorType === OAuthErrorType.INVALID_GRANT) {
      // Expired code - common issue, log as warning
      this.log.warn(logContext, 'oauth: invalid or expired grant');
    } else if (error.httpStatus && error.httpStatus >= 500) {
      // Server errors - log as error
      this.log.error(logContext, 'oauth: server error');
    } else {
      // Other errors - log as warning
      this.log.warn(logContext, 'oauth: operation failed');
    }
  }

  /**
   * Map OAuth error codes to standardized error types
   */
  private static mapErrorCode(errorCode: string): OAuthErrorType {
    const code = errorCode.toLowerCase();
    
    switch (code) {
      case 'invalid_request':
        return OAuthErrorType.INVALID_REQUEST;
      case 'invalid_client':
        return OAuthErrorType.INVALID_CLIENT;
      case 'invalid_grant':
        return OAuthErrorType.INVALID_GRANT;
      case 'unauthorized_client':
        return OAuthErrorType.UNAUTHORIZED_CLIENT;
      case 'unsupported_grant_type':
        return OAuthErrorType.UNSUPPORTED_GRANT_TYPE;
      case 'invalid_scope':
        return OAuthErrorType.INVALID_SCOPE;
      case 'access_denied':
        return OAuthErrorType.ACCESS_DENIED;
      default:
        return OAuthErrorType.UNKNOWN;
    }
  }

  /**
   * Check if an error is retryable
   */
  static isRetryableError(error: OAuthError): boolean {
    const retryableTypes = [
      OAuthErrorType.NETWORK_ERROR,
      OAuthErrorType.TIMEOUT,
    ];

    return retryableTypes.includes(error.errorType) || 
           (error.httpStatus !== undefined && error.httpStatus >= 500);
  }

  /**
   * Get retry delay for retryable errors (exponential backoff)
   */
  static getRetryDelay(attempt: number, baseDelay: number = 1000): number {
    return Math.min(baseDelay * Math.pow(2, attempt - 1), 30000); // Max 30 seconds
  }
}
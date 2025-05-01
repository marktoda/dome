/**
 * Authentication error types
 */
export enum AuthErrorType {
  INVALID_CREDENTIALS = 'invalid_credentials',
  USER_NOT_FOUND = 'user_not_found',
  USER_EXISTS = 'user_exists',
  INVALID_TOKEN = 'invalid_token',
  TOKEN_EXPIRED = 'token_expired',
  MISSING_TOKEN = 'missing_token',
  INSUFFICIENT_PERMISSIONS = 'insufficient_permissions',
  REGISTRATION_FAILED = 'registration_failed',
  LOGIN_FAILED = 'login_failed',
  INTERNAL_ERROR = 'internal_error',
}

/**
 * Authentication error class
 */
export class AuthError extends Error {
  type: AuthErrorType;
  status: number;

  /**
   * Create a new authentication error
   * @param message Error message
   * @param type Error type
   * @param status HTTP status code
   */
  constructor(message: string, type: AuthErrorType, status: number = 401) {
    super(message);
    this.name = 'AuthError';
    this.type = type;
    this.status = status;
    
    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AuthError);
    }
  }

  /**
   * Convert to JSON for response
   */
  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
      },
    };
  }
}
/**
 * Base error class for all application errors
 */
export declare class BaseError extends Error {
  code: string;
  status: number;
  details?: Record<string, any>;
  /**
   * Creates a new BaseError
   * @param message Error message
   * @param code Error code
   * @param status HTTP status code
   * @param details Additional error details
   */
  constructor(message: string, code: string, status?: number, details?: Record<string, any>);
}

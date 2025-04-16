/**
 * Common types for the Communicator services
 */

/**
 * Service information interface
 */
export interface ServiceInfo {
  name: string;
  version: string;
  environment: string;
}

/**
 * Standard API response format
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    requestId?: string;
    details?: Record<string, any>;
  };
}

export * from './message';

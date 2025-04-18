/**
 * Common types for the Dome project
 */

// Export message types
export * from './message';

// Export event types
export * from './events';

// Export embedding types
export * from './embedding';

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

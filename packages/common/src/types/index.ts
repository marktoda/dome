/**
 * Common types for the Dome project
 */

// Export message types
export * from './message.js';

// Export event types
export * from './events.js';

// Export embedding types
export * from './embedding.js';

// Export silo content types
export * from './siloContent.js';

// Export queue message types
export * from './queueMessages.js';

// Export enriched content types
export * from './enrichedContent.js';

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

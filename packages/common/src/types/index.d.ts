/**
 * Common types for the Dome project
 */
export * from './message';
export * from './events';
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

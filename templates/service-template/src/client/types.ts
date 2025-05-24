/**
 * Configuration options for the {{SERVICE_NAME}} client
 */
export interface {{SERVICE_NAME}}ClientOptions {
  /** Base URL of the {{SERVICE_NAME}} service */
  baseUrl: string;
  
  /** Optional API key for authentication */
  apiKey?: string;
  
  /** Optional timeout in milliseconds */
  timeout?: number;
}

/**
 * Example response type - replace with actual service response types
 */
export interface {{SERVICE_NAME}}Response {
  message: string;
  timestamp: string;
  data?: any;
}

/**
 * Example request type - replace with actual service request types
 */
export interface {{SERVICE_NAME}}Request {
  input: string;
  options?: {
    [key: string]: any;
  };
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: string;
  service: string;
  timestamp: string;
}
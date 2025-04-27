import pino from 'pino';

/**
 * Standard log levels used throughout the application
 */
export enum LogLevel {
  TRACE = 'trace',
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
  FATAL = 'fatal',
  SILENT = 'silent'
}

/**
 * Configuration options for initializing the logging system
 */
export interface InitOptions {
  /**
   * Factory function to generate unique request IDs
   * Defaults to nanoid(12) if not provided
   */
  idFactory?: () => string;

  /**
   * Additional data to include with every log entry
   * Useful for adding application-wide context like service name, version, etc.
   */
  extraBindings?: Record<string, unknown>;

  /**
   * Log level to use
   * Can be one of: 'trace', 'debug', 'info', 'warn', 'error', 'fatal', or 'silent'
   * Defaults to 'info' if not provided
   */
  level?: pino.LevelWithSilent;

  /**
   * Custom serializer function for log objects
   * Can be used to transform or sanitize log data before output
   */
  serializer?: pino.SerializerFn;
}

/**
 * Standard event names used in log entries
 */
export enum LogEvent {
  REQUEST_START = 'request_start',
  REQUEST_END = 'request_end',
  REQUEST_ERROR = 'request_error',
  OPERATION_START = 'operation_start',
  OPERATION_END = 'operation_end',
  OPERATION_ERROR = 'operation_error',
  EXTERNAL_CALL = 'external_call',
  DATABASE_QUERY = 'database_query',
  CACHE_HIT = 'cache_hit',
  CACHE_MISS = 'cache_miss',
  WORKER_START = 'worker_start',
  WORKER_SHUTDOWN = 'worker_shutdown'
}

/**
 * Standard metric types used in the application
 */
export enum MetricType {
  COUNTER = 'counter',
  GAUGE = 'gauge',
  HISTOGRAM = 'histogram',
  SUMMARY = 'summary'
}

/**
 * Standard context fields for requests
 */
export interface RequestContext {
  /** Unique identifier for the request */
  requestId: string;
  /** Request URL path */
  path: string;
  /** HTTP method used */
  method: string;
  /** User agent string */
  userAgent?: string;
  /** Client IP address */
  ip?: string;
  /** Content-length header value */
  contentLength?: number;
  /** Referring URL */
  referer?: string;
  /** Request country (from Cloudflare) */
  country?: string;
  /** Request origin */
  origin?: string;
  [key: string]: any;
}

/**
 * Standard context fields for operations
 */
export interface OperationContext {
  /** Unique identifier for the operation */
  operationId?: string;
  /** Name of the operation being performed */
  operation: string;
  /** Component performing the operation */
  component?: string;
  /** Duration of the operation in milliseconds */
  duration?: number;
  /** Whether the operation was successful */
  success?: boolean;
  [key: string]: any;
}

/**
 * Standard context fields for external calls
 */
export interface ExternalCallContext {
  /** Destination URL */
  url: string;
  /** HTTP method used */
  method: string;
  /** HTTP status code received */
  status?: number;
  /** Duration of the call in milliseconds */
  duration?: number;
  /** Size of the response in bytes */
  responseSize?: number;
  /** Whether the call was successful */
  success?: boolean;
  /** Request ID to correlate across services */
  requestId?: string;
  [key: string]: any;
}

/**
 * Standard context fields for database operations
 */
export interface DatabaseContext {
  /** Type of database operation */
  operation: 'query' | 'insert' | 'update' | 'delete' | 'transaction';
  /** Database table or collection being accessed */
  table?: string;
  /** Duration of the operation in milliseconds */
  duration?: number;
  /** Number of rows/documents affected */
  affectedRows?: number;
  /** Whether the operation was successful */
  success?: boolean;
  [key: string]: any;
}

/**
 * Context for sanitizing logs
 */
export interface SanitizeOptions {
  /** Fields to completely remove from logs */
  removeFields?: string[];
  /** Fields to mask (e.g. show only last 4 characters) */
  maskFields?: string[];
  /** Size limit for large fields (will be truncated if larger) */
  maxFieldSize?: number;
}

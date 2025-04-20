import { getLogger, InitOptions } from '@dome/logging';
import { ulid } from 'ulid';

/**
 * Log levels
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Logger interface
 */
export interface Logger {
  debug: (dataOrMessage: Record<string, any> | string, message?: string) => void;
  info: (dataOrMessage: Record<string, any> | string, message?: string) => void;
  warn: (dataOrMessage: Record<string, any> | string, message?: string) => void;
  error: (dataOrMessage: Record<string, any> | string, message?: string) => void;
  child: (context: Record<string, any>) => Logger;
  withRequestId: (requestId?: string) => Logger;
}

/**
 * Initialize the logger with environment-specific configuration
 * @param env Environment variables
 */
export function initLogger(env: { LOG_LEVEL: string; ENVIRONMENT: string; VERSION: string }): void {
  // Set global log level based on environment
  globalLogLevel = (env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  
  // Set default context for all logs
  defaultContext = {
    service: 'github-ingestor',
    version: env.VERSION || 'unknown',
    environment: env.ENVIRONMENT || 'development',
  };
}

// Default log level if not initialized
let globalLogLevel: LogLevel = LogLevel.INFO;

// Default context for all logs
let defaultContext: Record<string, any> = {
  service: 'github-ingestor',
};

/**
 * Check if a log level should be emitted based on the global log level
 * @param level Log level to check
 * @returns Whether the log should be emitted
 */
function shouldLog(level: LogLevel): boolean {
  const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
  const configuredLevelIndex = levels.indexOf(globalLogLevel);
  const logLevelIndex = levels.indexOf(level);
  
  return logLevelIndex >= configuredLevelIndex;
}

/**
 * Format a log entry with standard fields
 * @param level Log level
 * @param dataOrMessage Data or message to log
 * @param message Optional message if data is provided
 * @param context Additional context
 * @returns Formatted log entry
 */
function formatLogEntry(
  level: LogLevel,
  dataOrMessage: Record<string, any> | string,
  message?: string,
  context: Record<string, any> = {}
): Record<string, any> {
  const timestamp = new Date().toISOString();
  
  if (typeof dataOrMessage === 'string') {
    return {
      level,
      timestamp,
      message: dataOrMessage,
      ...defaultContext,
      ...context,
    };
  } else {
    return {
      level,
      timestamp,
      ...defaultContext,
      ...context,
      ...dataOrMessage,
      message: message || dataOrMessage.message || '',
    };
  }
}

/**
 * Create a logger instance with the specified context
 * @param context Context to add to all log entries
 * @returns Logger instance
 */
function createLogger(context: Record<string, any> = {}): Logger {
  return {
    debug: (dataOrMessage: Record<string, any> | string, message?: string) => {
      if (!shouldLog(LogLevel.DEBUG)) return;
      const entry = formatLogEntry(LogLevel.DEBUG, dataOrMessage, message, context);
      console.debug(JSON.stringify(entry));
    },
    
    info: (dataOrMessage: Record<string, any> | string, message?: string) => {
      if (!shouldLog(LogLevel.INFO)) return;
      const entry = formatLogEntry(LogLevel.INFO, dataOrMessage, message, context);
      console.log(JSON.stringify(entry));
    },
    
    warn: (dataOrMessage: Record<string, any> | string, message?: string) => {
      if (!shouldLog(LogLevel.WARN)) return;
      const entry = formatLogEntry(LogLevel.WARN, dataOrMessage, message, context);
      console.warn(JSON.stringify(entry));
    },
    
    error: (dataOrMessage: Record<string, any> | string, message?: string) => {
      if (!shouldLog(LogLevel.ERROR)) return;
      const entry = formatLogEntry(LogLevel.ERROR, dataOrMessage, message, context);
      console.error(JSON.stringify(entry));
    },
    
    child: (childContext: Record<string, any>) => {
      return createLogger({ ...context, ...childContext });
    },
    
    withRequestId: (requestId?: string) => {
      const rid = requestId || ulid();
      return createLogger({ ...context, request_id: rid });
    },
  };
}

/**
 * Global logger instance
 * This will be properly initialized in the worker entrypoint
 */
export const logger: Logger = createLogger();

/**
 * Log an error with context
 * @param error Error object
 * @param message Optional message
 * @param context Additional context
 */
export function logError(error: Error, message?: string, context: Record<string, any> = {}) {
  logger.error(
    {
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
      ...context,
    },
    message || 'An error occurred'
  );
}

/**
 * Create a child logger with additional context
 * @param context Context to add to all log entries
 * @returns Child logger
 */
export function createChildLogger(context: Record<string, any>): Logger {
  return logger.child(context);
}

/**
 * Create a request-scoped logger with a request ID
 * @param requestId Optional request ID (generated if not provided)
 * @returns Logger with request ID
 */
export function createRequestLogger(requestId?: string): Logger {
  return logger.withRequestId(requestId);
}

/**
 * Create a repository-scoped logger
 * @param owner Repository owner
 * @param repo Repository name
 * @param userId User ID (optional)
 * @returns Logger with repository context
 */
export function createRepoLogger(owner: string, repo: string, userId?: string): Logger {
  const context: Record<string, any> = { owner, repo };
  if (userId) context.user_id = userId;
  return logger.child(context);
}

/**
 * Set the global log level
 * @param level Log level to set
 */
export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
  logger.info({ new_log_level: level }, 'Log level changed');
}
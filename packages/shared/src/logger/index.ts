import winston from 'winston';

import { config } from '../config/index.js';

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

// Custom format for development
const devFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }

  if (stack) {
    msg += `\n${stack}`;
  }

  return msg;
});

// Create logger instance
export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    config.NODE_ENV === 'development' ? combine(colorize(), devFormat) : json()
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});

// Add file transport in production
if (config.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    })
  );

  logger.add(
    new winston.transports.File({
      filename: 'logs/combined.log',
    })
  );
}

// Create child loggers for specific modules
export const createLogger = (module: string) => {
  return logger.child({ module });
};

// Utility functions for structured logging
export const logError = (error: Error, context?: Record<string, unknown>) => {
  logger.error(error.message, {
    stack: error.stack,
    name: error.name,
    ...context,
  });
};

export const logInfo = (message: string, metadata?: Record<string, unknown>) => {
  logger.info(message, metadata);
};

export const logDebug = (message: string, metadata?: Record<string, unknown>) => {
  logger.debug(message, metadata);
};

export const logWarn = (message: string, metadata?: Record<string, unknown>) => {
  logger.warn(message, metadata);
};

// Performance logging
export const logPerformance = (
  operation: string,
  duration: number,
  metadata?: Record<string, unknown>
) => {
  logger.info(`Performance: ${operation}`, {
    duration_ms: duration,
    ...metadata,
  });
};

// Request logging middleware helper
export interface RequestLogContext {
  method: string;
  url: string;
  statusCode?: number;
  duration?: number;
  userId?: string;
  error?: Error;
}

export const logRequest = (context: RequestLogContext) => {
  const { error, ...metadata } = context;

  if (error) {
    logger.error(`Request failed: ${context.method} ${context.url}`, {
      ...metadata,
      error: error.message,
      stack: error.stack,
    });
  } else {
    logger.info(`Request completed: ${context.method} ${context.url}`, metadata);
  }
};

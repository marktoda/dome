import winston from 'winston';
import { Writable } from 'stream';
import { LOGGING, SERVER } from '../config';
import 'winston-daily-rotate-file';
import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
  verbose: 5,
};

// Define log colors
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
  verbose: 'cyan',
};

// Add colors to winston
winston.addColors(colors);

/**
 * Create a request ID namespace for tracking requests across logs
 */
const requestIdSymbol = Symbol('requestId');
export const getRequestId = (req: Request): string => {
  if (!(requestIdSymbol in req)) {
    (req as any)[requestIdSymbol] = uuidv4();
  }
  return (req as any)[requestIdSymbol];
};

/**
 * Create format for development (pretty, colorized)
 */
const developmentFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    ({ level, message, timestamp, requestId, ...meta }: Record<string, any>) => {
      const requestIdStr = requestId ? `[${requestId}] ` : '';
      const metaStr =
        Object.keys(meta).length && meta.stack !== message
          ? `\n${JSON.stringify(meta, null, 2)}`
          : '';
      return `${timestamp} ${level}: ${requestIdStr}${message}${metaStr}`;
    },
  ),
);

/**
 * Create format for production (JSON)
 */
const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
);

/**
 * Select the appropriate format based on environment
 */
const format =
  SERVER.IS_PRODUCTION || LOGGING.FORMAT === 'json' ? productionFormat : developmentFormat;

/**
 * Configure transports based on environment
 */
const transports: winston.transport[] = [
  // Console transport for all environments
  new winston.transports.Console(),
];

// Add file transports for production
if (SERVER.IS_PRODUCTION) {
  // Daily rotate file transport for error logs
  transports.push(
    new (winston.transports as any).DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: 'error',
    }),
  );

  // Daily rotate file transport for all logs
  transports.push(
    new (winston.transports as any).DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
  );
}

/**
 * Create a Winston logger instance
 */
export const logger = winston.createLogger({
  level: LOGGING.LEVEL || 'info',
  levels,
  format,
  defaultMeta: { service: 'telegram-proxy-service' },
  transports,
  exitOnError: false,
});

/**
 * Stream for Morgan HTTP request logger
 */
export const logStream = new Writable({
  write: (message: string) => {
    logger.http(message.trim());
  },
});

/**
 * Log an API request
 * @param req Express request object
 * @param message Optional message
 * @param meta Optional metadata
 */
export const logRequest = (
  req: Request,
  message?: string,
  meta: Record<string, any> = {},
): string => {
  const requestId = getRequestId(req);
  const logData = {
    requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    ...meta,
  };

  logger.info(message || 'API Request', logData);
  return requestId;
};

/**
 * Log an API response
 * @param req Express request object
 * @param statusCode HTTP status code
 * @param responseTime Response time in ms
 * @param meta Optional metadata
 */
export const logResponse = (
  req: Request,
  statusCode: number,
  responseTime: number,
  meta: Record<string, any> = {},
): void => {
  const requestId = getRequestId(req);
  const logData = {
    requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    statusCode,
    responseTime: `${responseTime}ms`,
    ...meta,
  };

  // Log at appropriate level based on status code
  if (statusCode >= 500) {
    logger.error('API Response', logData);
  } else if (statusCode >= 400) {
    logger.warn('API Response', logData);
  } else {
    logger.info('API Response', logData);
  }
};

/**
 * Log an error with request context
 * @param error Error object
 * @param req Express request object (optional)
 * @param meta Optional metadata
 */
export const logError = (error: Error, req?: Request, meta: Record<string, any> = {}): void => {
  const logData: Record<string, any> = {
    ...meta,
    stack: error.stack,
  };

  if (req) {
    const requestId = getRequestId(req);
    logData.requestId = requestId;
    logData.method = req.method;
    logData.url = req.originalUrl || req.url;
  }

  logger.error(`Error: ${error.message}`, logData);
};

// Set up global error handlers
if (!SERVER.IS_TEST) {
  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
    // Give the logger time to flush before exiting
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('Unhandled Rejection:', {
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

export default logger;

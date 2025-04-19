/**
 * Standardized Logger
 *
 * Provides a wrapper around the @dome/logging logger to ensure consistent
 * logging patterns across the Constellation service.
 */

import { getLogger } from '@dome/logging';
import type { Logger } from 'pino';

/**
 * Interface for the standardized logger
 */
interface StandardizedLogger {
  info: (objOrMsg: Record<string, any> | string, msg?: string) => void;
  debug: (objOrMsg: Record<string, any> | string, msg?: string) => void;
  warn: (objOrMsg: Record<string, any> | string, msg?: string) => void;
  error: (objOrMsg: Record<string, any> | string, msg?: string) => void;
  child: (bindings: Record<string, any>) => StandardizedLogger;
}

/**
 * Standardized logger that ensures all log messages follow the pattern:
 * logger.info({ ...objects, message: 'message' })
 */
export const logger: StandardizedLogger = {
  /**
   * Log an informational message
   * @param objOrMsg Object with properties to log or message string
   * @param msg Optional message string if first parameter is an object
   */
  info: (objOrMsg: Record<string, any> | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      // Handle case: logger.info('message')
      getLogger().info({ message: objOrMsg });
    } else if (msg) {
      // Handle case: logger.info({ ...props }, 'message')
      getLogger().info({ ...objOrMsg, message: msg });
    } else {
      // Handle case: logger.info({ ...props, message: 'message' })
      getLogger().info(objOrMsg);
    }
  },

  /**
   * Log a debug message
   * @param objOrMsg Object with properties to log or message string
   * @param msg Optional message string if first parameter is an object
   */
  debug: (objOrMsg: Record<string, any> | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      // Handle case: logger.debug('message')
      getLogger().debug({ message: objOrMsg });
    } else if (msg) {
      // Handle case: logger.debug({ ...props }, 'message')
      getLogger().debug({ ...objOrMsg, message: msg });
    } else {
      // Handle case: logger.debug({ ...props, message: 'message' })
      getLogger().debug(objOrMsg);
    }
  },

  /**
   * Log a warning message
   * @param objOrMsg Object with properties to log or message string
   * @param msg Optional message string if first parameter is an object
   */
  warn: (objOrMsg: Record<string, any> | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      // Handle case: logger.warn('message')
      getLogger().warn({ message: objOrMsg });
    } else if (msg) {
      // Handle case: logger.warn({ ...props }, 'message')
      getLogger().warn({ ...objOrMsg, message: msg });
    } else {
      // Handle case: logger.warn({ ...props, message: 'message' })
      getLogger().warn(objOrMsg);
    }
  },

  /**
   * Log an error message
   * @param objOrMsg Object with properties to log or message string
   * @param msg Optional message string if first parameter is an object
   */
  error: (objOrMsg: Record<string, any> | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      // Handle case: logger.error('message')
      getLogger().error({ message: objOrMsg });
    } else if (msg) {
      // Handle case: logger.error({ ...props }, 'message')
      getLogger().error({ ...objOrMsg, message: msg });
    } else {
      // Handle case: logger.error({ ...props, message: 'message' })
      getLogger().error(objOrMsg);
    }
  },

  /**
   * Create a child logger with additional context
   * @param bindings Object with properties to include in all logs
   * @returns A new standardized logger with the bindings
   */
  child: (bindings: Record<string, any>): typeof logger => {
    const childBaseLogger = getLogger().child(bindings);

    return {
      info: (objOrMsg: Record<string, any> | string, msg?: string) => {
        if (typeof objOrMsg === 'string') {
          childBaseLogger.info({ message: objOrMsg });
        } else if (msg) {
          childBaseLogger.info({ ...objOrMsg, message: msg });
        } else {
          childBaseLogger.info(objOrMsg);
        }
      },
      debug: (objOrMsg: Record<string, any> | string, msg?: string) => {
        if (typeof objOrMsg === 'string') {
          childBaseLogger.debug({ message: objOrMsg });
        } else if (msg) {
          childBaseLogger.debug({ ...objOrMsg, message: msg });
        } else {
          childBaseLogger.debug(objOrMsg);
        }
      },
      warn: (objOrMsg: Record<string, any> | string, msg?: string) => {
        if (typeof objOrMsg === 'string') {
          childBaseLogger.warn({ message: objOrMsg });
        } else if (msg) {
          childBaseLogger.warn({ ...objOrMsg, message: msg });
        } else {
          childBaseLogger.warn(objOrMsg);
        }
      },
      error: (objOrMsg: Record<string, any> | string, msg?: string) => {
        if (typeof objOrMsg === 'string') {
          childBaseLogger.error({ message: objOrMsg });
        } else if (msg) {
          childBaseLogger.error({ ...objOrMsg, message: msg });
        } else {
          childBaseLogger.error(objOrMsg);
        }
      },
      child: logger.child,
    };
  },
};

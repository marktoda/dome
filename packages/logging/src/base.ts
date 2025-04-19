import pino, { Logger as PinoLogger } from 'pino';

/**
 * Global base logger – heavy Pino internals are initialised once per isolate.
 * This provides the foundation for all logging in the application.
 *
 * @remarks
 * The logger is configured to work in Cloudflare Workers environment
 * and outputs structured JSON logs that can be processed by Logpush.
 */
const pinoLogger = pino({
  level: (globalThis as any).LOG_LEVEL ?? 'info',

  // Ensure level is explicit and message is a top-level field
  formatters: {
    level(label) {
      return { level: label };
    },
    // Move the message to a top-level field
    log(object) {
      // If the object has a msg property, rename it to message
      if (object.msg) {
        object.message = object.msg;
        delete object.msg;
      }
      return object;
    },
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  // Ensure exactly one JSON object per line for Cloudflare to parse correctly
  browser: {
    asObject: true,
    write: (obj: any) => {
      // Ensure we're outputting a single, flat JSON object
      console.log(JSON.stringify(obj));
    },
  },

  // Add hooks for error handling
  hooks: {
    // bubble error.stack to top level – Cloudflare Logs shows it nicely
    logMethod(args: any[], method: any) {
      if (args.length && args[0] instanceof Error) {
        const err = args[0] as Error;
        args[0] = { err } as any; // `{ err:{ message, stack… } }`
      }
      method.apply(this, args as any);
    },
  },
});

/**
 * Standardized logger that ensures all log messages follow the pattern:
 * logger.info({ ...objects, message: 'message' })
 *
 * This wrapper intercepts the standard Pino logger methods and standardizes
 * the format to ensure consistent logging patterns across the application.
 */
export const baseLogger: PinoLogger = {
  ...pinoLogger,

  // Wrap the standard logging methods to standardize the format
  info: createStandardizedLogMethod(pinoLogger.info.bind(pinoLogger)),
  error: createStandardizedLogMethod(pinoLogger.error.bind(pinoLogger)),
  debug: createStandardizedLogMethod(pinoLogger.debug.bind(pinoLogger)),
  warn: createStandardizedLogMethod(pinoLogger.warn.bind(pinoLogger)),
  trace: createStandardizedLogMethod(pinoLogger.trace.bind(pinoLogger)),
  fatal: createStandardizedLogMethod(pinoLogger.fatal.bind(pinoLogger)),

  // Ensure child loggers also use the standardized methods
  child: function (bindings, options) {
    const childLogger = pinoLogger.child(bindings, options);
    return {
      ...childLogger,
      info: createStandardizedLogMethod(childLogger.info.bind(childLogger)),
      error: createStandardizedLogMethod(childLogger.error.bind(childLogger)),
      debug: createStandardizedLogMethod(childLogger.debug.bind(childLogger)),
      warn: createStandardizedLogMethod(childLogger.warn.bind(childLogger)),
      trace: createStandardizedLogMethod(childLogger.trace.bind(childLogger)),
      fatal: createStandardizedLogMethod(childLogger.fatal.bind(childLogger)),
      child: (this as any).child,
    };
  },
} as PinoLogger;

/**
 * Creates a standardized log method that ensures the message is always
 * included as a property in the log object.
 *
 * @param originalMethod The original Pino logger method
 * @returns A wrapped method that standardizes the log format
 */
function createStandardizedLogMethod(originalMethod: Function) {
  return function (this: any, ...args: any[]) {
    // Handle different call patterns:
    // 1. logger.info({ obj }, 'message')
    // 2. logger.info('message')
    // 3. logger.info({ obj, message: 'message' })

    if (args.length === 2 && typeof args[1] === 'string') {
      // Pattern: logger.info({ obj }, 'message')
      // Convert to: logger.info({ obj, message: 'message' })
      const [obj, message] = args;
      return originalMethod({ ...obj, message });
    } else if (args.length === 1 && typeof args[0] === 'string') {
      // Pattern: logger.info('message')
      // Convert to: logger.info({ message: 'message' })
      return originalMethod({ message: args[0] });
    } else {
      // Pattern: logger.info({ obj, message: 'message' })
      // Or any other pattern - pass through unchanged
      return originalMethod.apply(this, args);
    }
  };
}

/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

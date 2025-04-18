import pino from 'pino';

/**
 * Global base logger – heavy Pino internals are initialised once per isolate.
 * This provides the foundation for all logging in the application.
 *
 * @remarks
 * The logger is configured to work in Cloudflare Workers environment
 * and outputs structured JSON logs that can be processed by Logpush.
 */
export const baseLogger = pino({
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
});

/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

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
  
  // Ensure level is explicit
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  
  timestamp: pino.stdTimeFunctions.isoTime,
  
  // Ensure exactly one JSON object per line for Cloudflare to parse correctly
  browser: {
    asObject: true,
    write: (obj) => console.log(JSON.stringify(obj)) // exactly 1 JSON object per line
  },
});

/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

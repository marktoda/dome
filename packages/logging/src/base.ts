import pino, { Logger as PinoLogger } from 'pino';

/**
 * Global base logger – heavy Pino internals are initialised once per isolate.
 * This provides the foundation for all logging in the application.
 *
 * @remarks
 * The logger is configured to work in Cloudflare Workers environment
 * and outputs structured JSON logs that can be processed by Logpush.
 */
// Create a write function that can be replaced in tests
export const logWriter = {
  write: (obj: any) => {
    // Ensure we're outputting a single, flat JSON object
    console.log(JSON.stringify(obj));
  }
};

export const baseLogger = pino({
  level: (globalThis as any).LOG_LEVEL ?? 'info',

  timestamp: pino.stdTimeFunctions.isoTime,

  // Ensure exactly one JSON object per line for Cloudflare to parse correctly
  browser: {
    asObject: true,
    write: (obj: any) => logWriter.write(obj),
  },
});

/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

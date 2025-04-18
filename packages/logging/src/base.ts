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
  
  // keep the default `msg` key but make sure level is explicit
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  
  timestamp: pino.stdTimeFunctions.isoTime,
  
  /* IMPORTANT — emit the *object* as‑is */
  browser: {
    asObject: true,                 // Pino gives you a plain object
    write: (obj) => console.log(obj) // no stringify!
  },
});

/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

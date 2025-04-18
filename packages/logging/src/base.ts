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
  
  // Custom serializer to ensure message is included in the object
  // and only a single object is passed to console.log
  browser: {
    asObject: true,
    write: (obj: any) => {
      // Extract the message from the object
      const message = obj.msg;
      
      // Create a new object with the message field renamed to avoid duplication
      const newObj = { ...obj, message };
      
      // Remove the original msg field
      if ('msg' in newObj) {
        delete newObj.msg;
      }
      
      // Log the single object
      console.log(newObj);
    }
  },
});

/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

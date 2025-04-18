/**
 * Global base logger – heavy Pino internals are initialised once per isolate.
 * This provides the foundation for all logging in the application.
 *
 * @remarks
 * The logger is configured to work in Cloudflare Workers environment
 * and outputs structured JSON logs that can be processed by Logpush.
 */
export declare const baseLogger: import("pino").Logger<never, boolean>;
/**
 * Type definition for the base logger instance
 */
export type BaseLogger = typeof baseLogger;

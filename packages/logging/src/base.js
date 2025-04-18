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
    level: globalThis.LOG_LEVEL ?? 'info',
    browser: {
        asObject: true,
        write: (o) => console.log(JSON.stringify(o)),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
});
//# sourceMappingURL=base.js.map
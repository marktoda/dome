import { contextStorage } from 'hono/context-storage';
import { baseLogger } from './base';
import { nanoid } from 'nanoid';
/**
 * Creates a middleware handler that adds request-scoped logging to Hono applications.
 *
 * @param opts - Configuration options for the logging middleware
 * @returns A middleware handler that sets up request-scoped logging
 */
export function buildLoggingMiddleware(opts = {}) {
    const idFactory = opts.idFactory ?? (() => nanoid(12));
    const extra = opts.extraBindings ?? {};
    return async (c, next) => {
        const reqId = idFactory();
        const cfRequest = c.req.raw;
        // Create a child logger with request-specific context
        const child = baseLogger.child({
            reqId,
            ip: c.req.header('CF-Connecting-IP'),
            colo: cfRequest.cf?.colo,
            cfRay: c.req.raw.headers.get('cf-ray'),
            ...extra,
        });
        // Store the logger in the request context
        c.set('logger', child);
        await next();
    };
}
/**
 * Convenience function to wire both contextStorage & logging in one call.
 *
 * @param app - The Hono application instance
 * @param opts - Optional configuration for the logging middleware
 */
export function initLogging(app, opts) {
    app.use(contextStorage());
    app.use('*', buildLoggingMiddleware(opts));
}
//# sourceMappingURL=middleware.js.map
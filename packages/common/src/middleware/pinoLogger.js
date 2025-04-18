import { getPath } from 'hono/utils/url';
import pino from 'pino';
/**
 * Creates a Pino logger middleware for Hono
 * @param logger Optional Pino logger instance (default: creates a new logger with level "info")
 * @returns Middleware handler
 */
export function createPinoLoggerMiddleware(logger = pino({ level: 'info' })) {
  return async (c, next) => {
    const { method } = c.req;
    const path = getPath(c.req.raw);
    const requestId = c.get('requestId');
    logger.info(
      {
        requestId,
        request: {
          method,
          path,
        },
      },
      'Incoming request',
    );
    const start = Date.now();
    await next();
    const { status } = c.res;
    logger.info(
      {
        requestId,
        response: {
          status,
          ok: String(c.res.ok),
          time: formatTime(start),
        },
      },
      'Request completed',
    );
  };
}
/**
 * Formats a list of time values with commas and periods
 * @param times List of time values as strings
 * @returns Formatted time string
 */
function humanize(times) {
  const [delimiter, separator] = [',', '.'];
  const orderTimes = times.map(v => v.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, '$1' + delimiter));
  return orderTimes.join(separator);
}
/**
 * Formats the elapsed time in milliseconds or seconds
 * @param start Start time in milliseconds
 * @returns Formatted time string
 */
function formatTime(start) {
  const delta = Date.now() - start;
  return humanize([delta < 1000 ? delta + 'ms' : Math.round(delta / 1000) + 's']);
}
//# sourceMappingURL=pinoLogger.js.map

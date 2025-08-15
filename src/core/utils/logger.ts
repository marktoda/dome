import pino from 'pino';

// Resolve the desired log level once, in order of preference:
// 1. Explicit LOG_LEVEL env var
// 2. Legacy/shortcut DEBUG env var (any truthy value enables "debug")
// 3. Fallback to the default "info" level
const logLevel = process.env.LOG_LEVEL ?? (process.env.DEBUG ? 'debug' : 'info');

const logger = pino({
  level: logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:standard',
          },
        }
      : undefined,
});

export default logger;

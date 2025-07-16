import pino from 'pino';

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level: logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'SYS:standard'
        }
      }
      : undefined
});

export default logger;

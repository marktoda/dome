import { MastraLogger, LogLevel } from '@mastra/core/logger';
import pino from 'pino';
import pretty from 'pino-pretty';

// src/pino.ts
var PinoLogger = class extends MastraLogger {
  logger;
  constructor(options = {}) {
    super(options);
    let prettyStream = void 0;
    if (!options.overrideDefaultTransports) {
      prettyStream = pretty({
        colorize: true,
        levelFirst: true,
        ignore: "pid,hostname",
        colorizeObjects: true,
        translateTime: "SYS:standard",
        singleLine: false
      });
    }
    const transportsAry = [...this.getTransports().entries()];
    this.logger = pino(
      {
        name: options.name || "app",
        level: options.level || LogLevel.INFO,
        formatters: options.formatters
      },
      options.overrideDefaultTransports ? options?.transports?.default : transportsAry.length === 0 ? prettyStream : pino.multistream([
        ...transportsAry.map(([, transport]) => ({
          stream: transport,
          level: options.level || LogLevel.INFO
        })),
        {
          stream: prettyStream,
          level: options.level || LogLevel.INFO
        }
      ])
    );
  }
  debug(message, args = {}) {
    this.logger.debug(args, message);
  }
  info(message, args = {}) {
    this.logger.info(args, message);
  }
  warn(message, args = {}) {
    this.logger.warn(args, message);
  }
  error(message, args = {}) {
    this.logger.error(args, message);
  }
};

export { PinoLogger };

'use strict';

var logger = require('@mastra/core/logger');
var pino = require('pino');
var pretty = require('pino-pretty');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var pino__default = /*#__PURE__*/_interopDefault(pino);
var pretty__default = /*#__PURE__*/_interopDefault(pretty);

// src/pino.ts
var PinoLogger = class extends logger.MastraLogger {
  logger;
  constructor(options = {}) {
    super(options);
    let prettyStream = void 0;
    if (!options.overrideDefaultTransports) {
      prettyStream = pretty__default.default({
        colorize: true,
        levelFirst: true,
        ignore: "pid,hostname",
        colorizeObjects: true,
        translateTime: "SYS:standard",
        singleLine: false
      });
    }
    const transportsAry = [...this.getTransports().entries()];
    this.logger = pino__default.default(
      {
        name: options.name || "app",
        level: options.level || logger.LogLevel.INFO,
        formatters: options.formatters
      },
      options.overrideDefaultTransports ? options?.transports?.default : transportsAry.length === 0 ? prettyStream : pino__default.default.multistream([
        ...transportsAry.map(([, transport]) => ({
          stream: transport,
          level: options.level || logger.LogLevel.INFO
        })),
        {
          stream: prettyStream,
          level: options.level || logger.LogLevel.INFO
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

exports.PinoLogger = PinoLogger;

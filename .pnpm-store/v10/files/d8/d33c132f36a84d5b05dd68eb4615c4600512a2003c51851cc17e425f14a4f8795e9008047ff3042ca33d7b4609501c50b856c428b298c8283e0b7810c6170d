'use strict';

var chunkZIZ3CVHN_cjs = require('./chunk-ZIZ3CVHN.cjs');

// src/base.ts
var MastraBase = class {
  component = chunkZIZ3CVHN_cjs.RegisteredLogger.LLM;
  logger;
  name;
  telemetry;
  constructor({ component, name }) {
    this.component = component || chunkZIZ3CVHN_cjs.RegisteredLogger.LLM;
    this.name = name;
    this.logger = new chunkZIZ3CVHN_cjs.ConsoleLogger({ name: `${this.component} - ${this.name}` });
  }
  /**
   * Set the logger for the agent
   * @param logger
   */
  __setLogger(logger) {
    this.logger = logger;
    if (this.component !== chunkZIZ3CVHN_cjs.RegisteredLogger.LLM) {
      this.logger.debug(`Logger updated [component=${this.component}] [name=${this.name}]`);
    }
  }
  /**
   * Set the telemetry for the
   * @param telemetry
   */
  __setTelemetry(telemetry) {
    this.telemetry = telemetry;
    if (this.component !== chunkZIZ3CVHN_cjs.RegisteredLogger.LLM) {
      this.logger.debug(`Telemetry updated [component=${this.component}] [name=${this.telemetry.name}]`);
    }
  }
  /**
   * Get the telemetry on the vector
   * @returns telemetry
   */
  __getTelemetry() {
    return this.telemetry;
  }
  /* 
    get experimental_telemetry config
    */
  get experimental_telemetry() {
    return this.telemetry ? {
      // tracer: this.telemetry.tracer,
      tracer: this.telemetry.getBaggageTracer(),
      isEnabled: !!this.telemetry.tracer
    } : void 0;
  }
};

exports.MastraBase = MastraBase;

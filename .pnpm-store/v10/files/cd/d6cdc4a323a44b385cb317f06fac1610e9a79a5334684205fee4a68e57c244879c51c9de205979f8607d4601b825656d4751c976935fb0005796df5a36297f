'use strict';

// src/error/index.ts
var ErrorDomain = /* @__PURE__ */ ((ErrorDomain2) => {
  ErrorDomain2["TOOL"] = "TOOL";
  ErrorDomain2["AGENT"] = "AGENT";
  ErrorDomain2["MCP"] = "MCP";
  ErrorDomain2["AGENT_NETWORK"] = "AGENT_NETWORK";
  ErrorDomain2["MASTRA_SERVER"] = "MASTRA_SERVER";
  ErrorDomain2["MASTRA_TELEMETRY"] = "MASTRA_TELEMETRY";
  ErrorDomain2["MASTRA_WORKFLOW"] = "MASTRA_WORKFLOW";
  ErrorDomain2["MASTRA_VOICE"] = "MASTRA_VOICE";
  ErrorDomain2["MASTRA_VECTOR"] = "MASTRA_VECTOR";
  ErrorDomain2["LLM"] = "LLM";
  ErrorDomain2["EVAL"] = "EVAL";
  ErrorDomain2["A2A"] = "A2A";
  ErrorDomain2["MASTRA_INSTANCE"] = "MASTRA_INSTANCE";
  ErrorDomain2["MASTRA"] = "MASTRA";
  ErrorDomain2["DEPLOYER"] = "DEPLOYER";
  ErrorDomain2["STORAGE"] = "STORAGE";
  return ErrorDomain2;
})(ErrorDomain || {});
var ErrorCategory = /* @__PURE__ */ ((ErrorCategory2) => {
  ErrorCategory2["UNKNOWN"] = "UNKNOWN";
  ErrorCategory2["USER"] = "USER";
  ErrorCategory2["SYSTEM"] = "SYSTEM";
  ErrorCategory2["THIRD_PARTY"] = "THIRD_PARTY";
  return ErrorCategory2;
})(ErrorCategory || {});
var MastraBaseError = class extends Error {
  id;
  domain;
  category;
  details = {};
  message;
  constructor(errorDefinition, originalError) {
    let error;
    if (originalError instanceof Error) {
      error = originalError;
    } else if (originalError) {
      error = new Error(String(originalError));
    }
    const message = errorDefinition.text ?? error?.message ?? "Unknown error";
    super(message, { cause: error });
    this.id = errorDefinition.id;
    this.domain = errorDefinition.domain;
    this.category = errorDefinition.category;
    this.details = errorDefinition.details ?? {};
    this.message = message;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  /**
   * Returns a structured representation of the error, useful for logging or API responses.
   */
  toJSONDetails() {
    return {
      message: this.message,
      domain: this.domain,
      category: this.category,
      details: this.details
    };
  }
  toJSON() {
    return {
      message: this.message,
      details: this.toJSONDetails(),
      code: this.id
    };
  }
  toString() {
    return JSON.stringify(this.toJSON());
  }
};
var MastraError = class extends MastraBaseError {
};

exports.ErrorCategory = ErrorCategory;
exports.ErrorDomain = ErrorDomain;
exports.MastraBaseError = MastraBaseError;
exports.MastraError = MastraError;

'use strict';

// src/tools/tool.ts
var Tool = class {
  id;
  description;
  inputSchema;
  outputSchema;
  execute;
  mastra;
  constructor(opts) {
    this.id = opts.id;
    this.description = opts.description;
    this.inputSchema = opts.inputSchema;
    this.outputSchema = opts.outputSchema;
    this.execute = opts.execute;
    this.mastra = opts.mastra;
  }
};
function createTool(opts) {
  return new Tool(opts);
}

// src/tools/toolchecks.ts
function isVercelTool(tool) {
  return !!(tool && !(tool instanceof Tool) && "parameters" in tool);
}

exports.Tool = Tool;
exports.createTool = createTool;
exports.isVercelTool = isVercelTool;

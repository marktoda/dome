'use strict';

var chunk4Z3OU5RY_cjs = require('./chunk-4Z3OU5RY.cjs');
var zod = require('zod');

// src/integration/integration.ts
var Integration = class {
  name = "Integration";
  workflows;
  constructor() {
    this.workflows = {};
  }
  /**
   * Workflows
   */
  registerWorkflow(name, fn) {
    if (this.workflows[name]) {
      throw new Error(`Sync function "${name}" already registered`);
    }
    this.workflows[name] = fn;
  }
  getWorkflows({ serialized }) {
    if (serialized) {
      return Object.entries(this.workflows).reduce((acc, [k, v]) => {
        return {
          ...acc,
          [k]: {
            name: v.name
          }
        };
      }, {});
    }
    return this.workflows;
  }
  /**
   * TOOLS
   */
  getStaticTools(_params) {
    throw new Error("Method not implemented.");
  }
  async getTools(_params) {
    throw new Error("Method not implemented.");
  }
  async getApiClient() {
    throw new Error("Method not implemented");
  }
};
var OpenAPIToolset = class {
  authType = "API_KEY";
  constructor() {
  }
  get toolSchemas() {
    return {};
  }
  get toolDocumentations() {
    return {};
  }
  get baseClient() {
    return {};
  }
  async getApiClient() {
    throw new Error("API not implemented");
  }
  _generateIntegrationTools() {
    const { client: _client, ...clientMethods } = this.baseClient;
    const schemas = this.toolSchemas;
    const documentations = this.toolDocumentations;
    const tools = Object.keys(clientMethods).reduce((acc, key) => {
      const comment = documentations[key]?.comment;
      const fallbackComment = `Execute ${key}`;
      const tool = chunk4Z3OU5RY_cjs.createTool({
        id: key,
        inputSchema: schemas[key] || zod.z.object({}),
        description: comment || fallbackComment,
        // documentation: doc || fallbackComment,
        execute: async ({ context }) => {
          const client = await this.getApiClient();
          const value = client[key];
          return value({
            ...context
          });
        }
      });
      return { ...acc, [key]: tool };
    }, {});
    return tools;
  }
};

exports.Integration = Integration;
exports.OpenAPIToolset = OpenAPIToolset;

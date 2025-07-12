import { stringify, esm_default } from './chunk-MEGCYGBU.js';
import { validateBody } from './chunk-RSEO4XPX.js';
import { handleError } from './chunk-LF7P5PLR.js';
import { HTTPException } from './chunk-LCM566I4.js';
import { __export } from './chunk-MLKGABMK.js';
import { isVercelTool } from '@mastra/core/tools';

// src/server/handlers/tools.ts
var tools_exports = {};
__export(tools_exports, {
  executeAgentToolHandler: () => executeAgentToolHandler,
  executeToolHandler: () => executeToolHandler,
  getToolByIdHandler: () => getToolByIdHandler,
  getToolsHandler: () => getToolsHandler
});
async function getToolsHandler({ tools }) {
  try {
    if (!tools) {
      return {};
    }
    const serializedTools = Object.entries(tools).reduce(
      (acc, [id, _tool]) => {
        const tool = _tool;
        acc[id] = {
          ...tool,
          inputSchema: tool.inputSchema ? stringify(esm_default(tool.inputSchema)) : void 0,
          outputSchema: tool.outputSchema ? stringify(esm_default(tool.outputSchema)) : void 0
        };
        return acc;
      },
      {}
    );
    return serializedTools;
  } catch (error) {
    return handleError(error, "Error getting tools");
  }
}
async function getToolByIdHandler({ tools, toolId }) {
  try {
    const tool = Object.values(tools || {}).find((tool2) => tool2.id === toolId);
    if (!tool) {
      throw new HTTPException(404, { message: "Tool not found" });
    }
    const serializedTool = {
      ...tool,
      inputSchema: tool.inputSchema ? stringify(esm_default(tool.inputSchema)) : void 0,
      outputSchema: tool.outputSchema ? stringify(esm_default(tool.outputSchema)) : void 0
    };
    return serializedTool;
  } catch (error) {
    return handleError(error, "Error getting tool");
  }
}
function executeToolHandler(tools) {
  return async ({
    mastra,
    runId,
    toolId,
    data,
    runtimeContext
  }) => {
    try {
      if (!toolId) {
        throw new HTTPException(400, { message: "Tool ID is required" });
      }
      const tool = Object.values(tools || {}).find((tool2) => tool2.id === toolId);
      if (!tool) {
        throw new HTTPException(404, { message: "Tool not found" });
      }
      if (!tool?.execute) {
        throw new HTTPException(400, { message: "Tool is not executable" });
      }
      validateBody({ data });
      if (isVercelTool(tool)) {
        const result2 = await tool.execute(data);
        return result2;
      }
      const result = await tool.execute({
        context: data,
        mastra,
        runId,
        runtimeContext
      });
      return result;
    } catch (error) {
      return handleError(error, "Error executing tool");
    }
  };
}
async function executeAgentToolHandler({
  mastra,
  agentId,
  toolId,
  data,
  runtimeContext
}) {
  try {
    const agent = agentId ? mastra.getAgent(agentId) : null;
    if (!agent) {
      throw new HTTPException(404, { message: "Tool not found" });
    }
    const agentTools = await agent.getTools({ runtimeContext });
    const tool = Object.values(agentTools || {}).find((tool2) => tool2.id === toolId);
    if (!tool) {
      throw new HTTPException(404, { message: "Tool not found" });
    }
    if (!tool?.execute) {
      throw new HTTPException(400, { message: "Tool is not executable" });
    }
    const result = await tool.execute({
      context: data,
      runtimeContext,
      mastra,
      runId: agentId
    });
    return result;
  } catch (error) {
    return handleError(error, "Error executing tool");
  }
}

export { executeAgentToolHandler, executeToolHandler, getToolByIdHandler, getToolsHandler, tools_exports };

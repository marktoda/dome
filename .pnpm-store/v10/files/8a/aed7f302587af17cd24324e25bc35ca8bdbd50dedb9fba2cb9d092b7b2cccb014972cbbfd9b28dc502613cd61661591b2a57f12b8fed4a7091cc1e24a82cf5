'use strict';

var chunkLI436ITD_cjs = require('../../chunk-LI436ITD.cjs');
var chunkCCGRCYWJ_cjs = require('../../chunk-CCGRCYWJ.cjs');
var chunkPZQDCRPV_cjs = require('../../chunk-PZQDCRPV.cjs');
var chunk2KZFMI6P_cjs = require('../../chunk-2KZFMI6P.cjs');

// src/server/handlers/vNextNetwork.ts
async function getVNextNetworksHandler({
  mastra,
  runtimeContext
}) {
  try {
    const networks = mastra.vnext_getNetworks();
    const serializedNetworks = await Promise.all(
      networks.map(async (network) => {
        const routingAgent = await network.getRoutingAgent({ runtimeContext });
        const routingLLM = await routingAgent.getLLM({ runtimeContext });
        const agents = await network.getAgents({ runtimeContext });
        const workflows = await network.getWorkflows({ runtimeContext });
        const tools = await network.getTools({ runtimeContext });
        const networkInstruction = await network.getInstructions({ runtimeContext });
        return {
          id: network.id,
          name: network.name,
          instructions: networkInstruction,
          tools: await Promise.all(
            Object.values(tools).map(async (tool) => {
              return {
                id: tool.id,
                description: tool.description
              };
            })
          ),
          agents: await Promise.all(
            Object.values(agents).map(async (agent) => {
              const llm = await agent.getLLM({ runtimeContext });
              return {
                name: agent.name,
                provider: llm?.getProvider(),
                modelId: llm?.getModelId()
              };
            })
          ),
          workflows: await Promise.all(
            Object.values(workflows).map(async (workflow) => {
              return {
                name: workflow.name,
                description: workflow.description,
                inputSchema: workflow.inputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(workflow.inputSchema)) : void 0,
                outputSchema: workflow.outputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(workflow.outputSchema)) : void 0
              };
            })
          ),
          routingModel: {
            provider: routingLLM?.getProvider(),
            modelId: routingLLM?.getModelId()
          }
        };
      })
    );
    return serializedNetworks;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error getting networks");
  }
}
async function getVNextNetworkByIdHandler({
  mastra,
  networkId,
  runtimeContext
}) {
  try {
    const network = mastra.vnext_getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    const routingAgent = await network.getRoutingAgent({ runtimeContext });
    const routingLLM = await routingAgent.getLLM({ runtimeContext });
    const agents = await network.getAgents({ runtimeContext });
    const workflows = await network.getWorkflows({ runtimeContext });
    const tools = await network.getTools({ runtimeContext });
    const networkInstruction = await network.getInstructions({ runtimeContext });
    const serializedNetwork = {
      id: network.id,
      name: network.name,
      instructions: networkInstruction,
      agents: await Promise.all(
        Object.values(agents).map(async (agent) => {
          const llm = await agent.getLLM({ runtimeContext });
          return {
            name: agent.name,
            provider: llm?.getProvider(),
            modelId: llm?.getModelId()
          };
        })
      ),
      workflows: await Promise.all(
        Object.values(workflows).map(async (workflow) => {
          return {
            name: workflow.name,
            description: workflow.description,
            inputSchema: workflow.inputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(workflow.inputSchema)) : void 0,
            outputSchema: workflow.outputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(workflow.outputSchema)) : void 0
          };
        })
      ),
      tools: await Promise.all(
        Object.values(tools).map(async (tool) => {
          return {
            id: tool.id,
            description: tool.description
          };
        })
      ),
      routingModel: {
        provider: routingLLM?.getProvider(),
        modelId: routingLLM?.getModelId()
      }
    };
    return serializedNetwork;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error getting network by ID");
  }
}
async function generateVNextNetworkHandler({
  mastra,
  runtimeContext,
  networkId,
  body
}) {
  try {
    const network = mastra.vnext_getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    chunkCCGRCYWJ_cjs.validateBody({ message: body.message });
    const { message, threadId, resourceId } = body;
    const result = await network.generate(message, { runtimeContext, threadId, resourceId });
    return result;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error generating from network");
  }
}
async function streamGenerateVNextNetworkHandler({
  mastra,
  networkId,
  body,
  runtimeContext
}) {
  try {
    const network = mastra.vnext_getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    chunkCCGRCYWJ_cjs.validateBody({ message: body.message });
    const { message, threadId, resourceId } = body;
    const streamResult = await network.stream(message, {
      runtimeContext,
      threadId,
      resourceId
    });
    return streamResult;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error streaming from network");
  }
}
async function loopVNextNetworkHandler({
  mastra,
  networkId,
  body,
  runtimeContext
}) {
  try {
    const network = mastra.vnext_getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    chunkCCGRCYWJ_cjs.validateBody({ message: body.message });
    const { message } = body;
    const result = await network.loop(message, {
      runtimeContext
    });
    return result;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error looping network");
  }
}
async function loopStreamVNextNetworkHandler({
  mastra,
  networkId,
  body,
  runtimeContext
}) {
  try {
    const network = mastra.vnext_getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    chunkCCGRCYWJ_cjs.validateBody({ message: body.message });
    const { message, threadId, resourceId, maxIterations } = body;
    const result = await network.loopStream(message, {
      runtimeContext,
      threadId,
      resourceId,
      maxIterations
    });
    return result;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error streaming network loop");
  }
}

exports.generateVNextNetworkHandler = generateVNextNetworkHandler;
exports.getVNextNetworkByIdHandler = getVNextNetworkByIdHandler;
exports.getVNextNetworksHandler = getVNextNetworksHandler;
exports.loopStreamVNextNetworkHandler = loopStreamVNextNetworkHandler;
exports.loopVNextNetworkHandler = loopVNextNetworkHandler;
exports.streamGenerateVNextNetworkHandler = streamGenerateVNextNetworkHandler;

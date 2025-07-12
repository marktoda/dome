'use strict';

var chunkCCGRCYWJ_cjs = require('./chunk-CCGRCYWJ.cjs');
var chunkPZQDCRPV_cjs = require('./chunk-PZQDCRPV.cjs');
var chunk2KZFMI6P_cjs = require('./chunk-2KZFMI6P.cjs');
var chunk75ZPJI57_cjs = require('./chunk-75ZPJI57.cjs');

// src/server/handlers/network.ts
var network_exports = {};
chunk75ZPJI57_cjs.__export(network_exports, {
  generateHandler: () => generateHandler,
  getNetworkByIdHandler: () => getNetworkByIdHandler,
  getNetworksHandler: () => getNetworksHandler,
  streamGenerateHandler: () => streamGenerateHandler
});
async function getNetworksHandler({
  mastra,
  runtimeContext
}) {
  try {
    const networks = mastra.getNetworks();
    const serializedNetworks = await Promise.all(
      networks.map(async (network) => {
        const routingAgent = network.getRoutingAgent();
        const routingLLM = await routingAgent.getLLM({ runtimeContext });
        const agents = network.getAgents();
        return {
          id: network.formatAgentId(routingAgent.name),
          name: routingAgent.name,
          instructions: routingAgent.instructions,
          agents: await Promise.all(
            agents.map(async (agent) => {
              const llm = await agent.getLLM({ runtimeContext });
              return {
                name: agent.name,
                provider: llm?.getProvider(),
                modelId: llm?.getModelId()
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
async function getNetworkByIdHandler({
  mastra,
  networkId,
  runtimeContext
}) {
  try {
    const networks = mastra.getNetworks();
    const network = networks.find((network2) => {
      const routingAgent2 = network2.getRoutingAgent();
      return network2.formatAgentId(routingAgent2.name) === networkId;
    });
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    const routingAgent = network.getRoutingAgent();
    const routingLLM = await routingAgent.getLLM({ runtimeContext });
    const agents = network.getAgents();
    const serializedNetwork = {
      id: network.formatAgentId(routingAgent.name),
      name: routingAgent.name,
      instructions: routingAgent.instructions,
      agents: await Promise.all(
        agents.map(async (agent) => {
          const llm = await agent.getLLM({ runtimeContext });
          return {
            name: agent.name,
            provider: llm?.getProvider(),
            modelId: llm?.getModelId()
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
async function generateHandler({
  mastra,
  runtimeContext,
  networkId,
  body
}) {
  try {
    const network = mastra.getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    chunkCCGRCYWJ_cjs.validateBody({ messages: body.messages });
    const { messages, ...rest } = body;
    const result = await network.generate(messages, { ...rest, runtimeContext });
    return result;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error generating from network");
  }
}
async function streamGenerateHandler({
  mastra,
  networkId,
  body,
  runtimeContext
}) {
  try {
    const network = mastra.getNetwork(networkId);
    if (!network) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Network not found" });
    }
    chunkCCGRCYWJ_cjs.validateBody({ messages: body.messages });
    const { messages, output, ...rest } = body;
    const streamResult = await network.stream(messages, {
      output,
      ...rest,
      runtimeContext
    });
    const streamResponse = output ? streamResult.toTextStreamResponse() : streamResult.toDataStreamResponse({
      sendUsage: true,
      sendReasoning: true,
      getErrorMessage: (error) => {
        return `An error occurred while processing your request. ${error instanceof Error ? error.message : JSON.stringify(error)}`;
      }
    });
    return streamResponse;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error streaming from network");
  }
}

exports.generateHandler = generateHandler;
exports.getNetworkByIdHandler = getNetworkByIdHandler;
exports.getNetworksHandler = getNetworksHandler;
exports.network_exports = network_exports;
exports.streamGenerateHandler = streamGenerateHandler;

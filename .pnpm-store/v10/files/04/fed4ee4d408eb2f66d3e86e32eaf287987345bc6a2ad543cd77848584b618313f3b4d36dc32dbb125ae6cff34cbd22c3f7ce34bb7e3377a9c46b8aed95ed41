'use strict';

var chunk75ZPJI57_cjs = require('./chunk-75ZPJI57.cjs');
var a2a = require('@mastra/core/a2a');
var zod = require('zod');

// src/server/handlers/a2a.ts
var a2a_exports = {};
chunk75ZPJI57_cjs.__export(a2a_exports, {
  getAgentCardByIdHandler: () => getAgentCardByIdHandler,
  getAgentExecutionHandler: () => getAgentExecutionHandler,
  handleTaskCancel: () => handleTaskCancel,
  handleTaskGet: () => handleTaskGet,
  handleTaskSend: () => handleTaskSend,
  handleTaskSendSubscribe: () => handleTaskSendSubscribe
});
function normalizeError(error, reqId, taskId, logger) {
  let a2aError;
  if (error instanceof a2a.A2AError) {
    a2aError = error;
  } else if (error instanceof Error) {
    a2aError = a2a.A2AError.internalError(error.message, { stack: error.stack });
  } else {
    a2aError = a2a.A2AError.internalError("An unknown error occurred.", error);
  }
  if (taskId && !a2aError.taskId) {
    a2aError.taskId = taskId;
  }
  logger?.error(`Error processing request (Task: ${a2aError.taskId ?? "N/A"}, ReqID: ${reqId ?? "N/A"}):`, a2aError);
  return createErrorResponse(reqId, a2aError.toJSONRPCError());
}
function createErrorResponse(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    // Can be null if request ID was invalid/missing
    error
  };
}
function createSuccessResponse(id, result) {
  if (!id) {
    throw a2a.A2AError.internalError("Cannot create success response for null ID.");
  }
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}
function convertToCoreMessage(message) {
  return {
    role: message.role === "user" ? "user" : "assistant",
    content: message.parts.map((msg) => convertToCoreMessagePart(msg))
  };
}
function convertToCoreMessagePart(part) {
  switch (part.type) {
    case "text":
      return {
        type: "text",
        text: part.text
      };
    case "file":
      return {
        type: "file",
        data: new URL(part.file.uri),
        mimeType: part.file.mimeType
      };
    case "data":
      throw new Error("Data parts are not supported in core messages");
  }
}

// src/server/a2a/store.ts
var InMemoryTaskStore = class {
  store = /* @__PURE__ */ new Map();
  activeCancellations = /* @__PURE__ */ new Set();
  async load({ agentId, taskId }) {
    const entry = this.store.get(`${agentId}-${taskId}`);
    if (!entry) {
      return null;
    }
    return { task: { ...entry.task }, history: [...entry.history] };
  }
  async save({ agentId, data }) {
    const key = `${agentId}-${data.task.id}`;
    if (!data.task.id) {
      throw new Error("Task ID is required");
    }
    this.store.set(key, {
      task: { ...data.task },
      history: [...data.history]
    });
  }
};

// src/server/a2a/tasks.ts
function isTaskStatusUpdate(update) {
  return "state" in update && !("parts" in update);
}
function isArtifactUpdate(update) {
  return "parts" in update;
}
function applyUpdateToTaskAndHistory(current, update) {
  let newTask = structuredClone(current.task);
  let newHistory = structuredClone(current.history);
  if (isTaskStatusUpdate(update)) {
    newTask.status = {
      ...newTask.status,
      // Keep existing properties if not overwritten
      ...update,
      // Apply updates
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (update.message?.role === "agent") {
      newHistory.push(update.message);
    }
  } else if (isArtifactUpdate(update)) {
    if (!newTask.artifacts) {
      newTask.artifacts = [];
    } else {
      newTask.artifacts = [...newTask.artifacts];
    }
    const existingIndex = update.index ?? -1;
    let replaced = false;
    if (existingIndex >= 0 && existingIndex < newTask.artifacts.length) {
      const existingArtifact = newTask.artifacts[existingIndex];
      if (update.append) {
        const appendedArtifact = JSON.parse(JSON.stringify(existingArtifact));
        appendedArtifact.parts.push(...update.parts);
        if (update.metadata) {
          appendedArtifact.metadata = {
            ...appendedArtifact.metadata || {},
            ...update.metadata
          };
        }
        if (update.lastChunk !== void 0) appendedArtifact.lastChunk = update.lastChunk;
        if (update.description) appendedArtifact.description = update.description;
        newTask.artifacts[existingIndex] = appendedArtifact;
        replaced = true;
      } else {
        newTask.artifacts[existingIndex] = { ...update };
        replaced = true;
      }
    } else if (update.name) {
      const namedIndex = newTask.artifacts.findIndex((a) => a.name === update.name);
      if (namedIndex >= 0) {
        newTask.artifacts[namedIndex] = { ...update };
        replaced = true;
      }
    }
    if (!replaced) {
      newTask.artifacts.push({ ...update });
      if (newTask.artifacts.some((a) => a.index !== void 0)) {
        newTask.artifacts.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      }
    }
  }
  return { task: newTask, history: newHistory };
}
async function loadOrCreateTaskAndHistory({
  agentId,
  taskId,
  taskStore,
  message,
  sessionId,
  metadata,
  logger
}) {
  const data = await taskStore.load({ agentId, taskId });
  if (!data) {
    const initialTask = {
      id: taskId,
      sessionId,
      status: {
        state: "submitted",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        message: null
      },
      artifacts: [],
      metadata
    };
    const initialData = {
      task: initialTask,
      history: [message]
    };
    logger?.info(`[Task ${taskId}] Created new task and history.`);
    await taskStore.save({ agentId, data: initialData });
    return initialData;
  }
  logger?.info(`[Task ${taskId}] Loaded existing task and history.`);
  let updatedData = {
    task: data.task,
    history: [...data.history, message]
  };
  const { status } = data.task;
  const finalStates = ["completed", "failed", "canceled"];
  if (finalStates.includes(status.state)) {
    logger?.warn(`[Task ${taskId}] Received message for task in final state ${status.state}. Restarting.`);
    updatedData = applyUpdateToTaskAndHistory(updatedData, {
      state: "submitted",
      message: null
    });
  } else if (status.state === "input-required") {
    logger?.info(`[Task ${taskId}] Changing state from 'input-required' to 'working'.`);
    updatedData = applyUpdateToTaskAndHistory(updatedData, { state: "working" });
  } else if (status.state === "working") {
    logger?.warn(`[Task ${taskId}] Received message while already 'working'. Proceeding.`);
  }
  await taskStore.save({ agentId, data: updatedData });
  return {
    task: { ...updatedData.task },
    history: [...updatedData.history]
  };
}
function createTaskContext({
  task,
  userMessage,
  history,
  activeCancellations
}) {
  return {
    task: structuredClone(task),
    userMessage,
    history: structuredClone(history),
    isCancelled: () => activeCancellations.has(task.id)
  };
}

// src/server/handlers/a2a.ts
var taskSendParamsSchema = zod.z.object({
  id: zod.z.string().min(1, "Invalid or missing task ID (params.id)."),
  message: zod.z.object({
    parts: zod.z.array(
      zod.z.object({
        type: zod.z.enum(["text"]),
        text: zod.z.string()
      })
    )
  })
});
async function getAgentCardByIdHandler({
  mastra,
  agentId,
  executionUrl = `/a2a/${agentId}`,
  provider = {
    organization: "Mastra",
    url: "https://mastra.ai"
  },
  version = "1.0",
  runtimeContext
}) {
  const agent = mastra.getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent with ID ${agentId} not found`);
  }
  const [instructions, tools] = await Promise.all([
    agent.getInstructions({ runtimeContext }),
    agent.getTools({ runtimeContext })
  ]);
  const agentCard = {
    name: agent.id || agentId,
    description: instructions,
    url: executionUrl,
    provider,
    version,
    capabilities: {
      streaming: true,
      // All agents support streaming
      pushNotifications: false,
      stateTransitionHistory: false
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    // Convert agent tools to skills format for A2A protocol
    skills: Object.entries(tools).map(([toolId, tool]) => ({
      id: toolId,
      name: toolId,
      description: tool.description || `Tool: ${toolId}`,
      // Optional fields
      tags: ["tool"]
    }))
  };
  return agentCard;
}
function validateTaskSendParams(params) {
  try {
    taskSendParamsSchema.parse(params);
  } catch (error) {
    if (error instanceof zod.z.ZodError) {
      throw a2a.A2AError.invalidParams(error.errors[0].message);
    }
    throw error;
  }
}
async function handleTaskSend({
  requestId,
  params,
  taskStore,
  agent,
  agentId,
  logger,
  runtimeContext
}) {
  validateTaskSendParams(params);
  const { id: taskId, message, sessionId, metadata } = params;
  let currentData = await loadOrCreateTaskAndHistory({
    taskId,
    taskStore,
    agentId,
    message,
    sessionId,
    metadata
  });
  createTaskContext({
    task: currentData.task,
    userMessage: message,
    history: currentData.history,
    activeCancellations: taskStore.activeCancellations
  });
  try {
    const { text } = await agent.generate([convertToCoreMessage(message)], {
      runId: taskId,
      runtimeContext
    });
    currentData = applyUpdateToTaskAndHistory(currentData, {
      state: "completed",
      message: {
        role: "agent",
        parts: [
          {
            type: "text",
            text
          }
        ]
      }
    });
    await taskStore.save({ agentId, data: currentData });
  } catch (handlerError) {
    const failureStatusUpdate = {
      state: "failed",
      message: {
        role: "agent",
        parts: [
          {
            type: "text",
            text: `Handler failed: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`
          }
        ]
      }
    };
    currentData = applyUpdateToTaskAndHistory(currentData, failureStatusUpdate);
    try {
      await taskStore.save({ agentId, data: currentData });
    } catch (saveError) {
      logger?.error(`Failed to save task ${taskId} after handler error:`, saveError?.message);
    }
    return normalizeError(handlerError, requestId, taskId, logger);
  }
  return createSuccessResponse(requestId, currentData.task);
}
async function handleTaskGet({
  requestId,
  taskStore,
  agentId,
  taskId
}) {
  const task = await taskStore.load({ agentId, taskId });
  if (!task) {
    throw a2a.A2AError.taskNotFound(taskId);
  }
  return createSuccessResponse(requestId, task);
}
async function* handleTaskSendSubscribe({
  requestId,
  params,
  taskStore,
  agent,
  agentId,
  logger,
  runtimeContext
}) {
  yield createSuccessResponse(requestId, {
    state: "working",
    message: {
      role: "agent",
      parts: [{ type: "text", text: "Generating response..." }]
    }
  });
  let result;
  try {
    result = await handleTaskSend({
      requestId,
      params,
      taskStore,
      agent,
      agentId,
      runtimeContext,
      logger
    });
  } catch (err) {
    if (!(err instanceof a2a.A2AError)) {
      throw err;
    }
    result = createErrorResponse(requestId, err.toJSONRPCError());
  }
  yield result;
}
async function handleTaskCancel({
  requestId,
  taskStore,
  agentId,
  taskId,
  logger
}) {
  let data = await taskStore.load({
    agentId,
    taskId
  });
  if (!data) {
    throw a2a.A2AError.taskNotFound(taskId);
  }
  const finalStates = ["completed", "failed", "canceled"];
  if (finalStates.includes(data.task.status.state)) {
    logger?.info(`Task ${taskId} already in final state ${data.task.status.state}, cannot cancel.`);
    return createSuccessResponse(requestId, data.task);
  }
  taskStore.activeCancellations.add(taskId);
  const cancelUpdate = {
    state: "canceled",
    message: {
      role: "agent",
      parts: [{ type: "text", text: "Task cancelled by request." }]
    }
  };
  data = applyUpdateToTaskAndHistory(data, cancelUpdate);
  await taskStore.save({ agentId, data });
  taskStore.activeCancellations.delete(taskId);
  return createSuccessResponse(requestId, data.task);
}
async function getAgentExecutionHandler({
  requestId,
  mastra,
  agentId,
  runtimeContext,
  method,
  params,
  taskStore = new InMemoryTaskStore(),
  logger
}) {
  const agent = mastra.getAgent(agentId);
  let taskId;
  try {
    taskId = params.id;
    switch (method) {
      case "tasks/send": {
        const result2 = await handleTaskSend({
          requestId,
          params,
          taskStore,
          agent,
          agentId,
          runtimeContext
        });
        return result2;
      }
      case "tasks/sendSubscribe":
        const result = await handleTaskSendSubscribe({
          requestId,
          taskStore,
          params,
          agent,
          agentId,
          runtimeContext
        });
        return result;
      case "tasks/get": {
        const result2 = await handleTaskGet({
          requestId,
          taskStore,
          agentId,
          taskId
        });
        return result2;
      }
      case "tasks/cancel": {
        const result2 = await handleTaskCancel({
          requestId,
          taskStore,
          agentId,
          taskId
        });
        return result2;
      }
      default:
        throw a2a.A2AError.methodNotFound(method);
    }
  } catch (error) {
    if (error instanceof a2a.A2AError && taskId && !error.taskId) {
      error.taskId = taskId;
    }
    return normalizeError(error, requestId, taskId, logger);
  }
}

exports.a2a_exports = a2a_exports;
exports.getAgentCardByIdHandler = getAgentCardByIdHandler;
exports.getAgentExecutionHandler = getAgentExecutionHandler;
exports.handleTaskCancel = handleTaskCancel;
exports.handleTaskGet = handleTaskGet;
exports.handleTaskSend = handleTaskSend;
exports.handleTaskSendSubscribe = handleTaskSendSubscribe;

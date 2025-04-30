// src/nodes/toolRouter.ts
import { z, ZodObject, ZodTypeAny } from "zod";
import { getLogger } from "@dome/logging";
import { ObservabilityService } from "../services/observabilityService";
import { LlmService } from "../services/llmService";
import { buildMessages } from '../utils';
import { getToolRoutingPrompt } from "../config/promptsConfig";
import { ToolRegistry } from "../tools";
import { AgentState, UserTaskEntity, Document, AIMessage, MessagePair } from "../types";

type Message = { role: "system" | "user" | "assistant"; content: string };

export interface ToolSelectionResult {
  toolName: string;
  confidence: number;
  reason: string;
}

export interface TaskAnalysisResult {
  needsTool: boolean;
  recommendedTools: string[];
  completable: boolean;
  reasoning: string;
  confidence: number;
}

/* ------------------------------------------------------------------ *
 * helpers                                                            *
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * core node                                                          *
 * ------------------------------------------------------------------ */

export async function toolRouter(
  state: AgentState,
  env: Env,
  tools: ToolRegistry,
): Promise<Partial<AgentState>> {
  const log = getLogger().child({ node: "toolRouter" });
  const t0 = performance.now();
  const traceId = state.metadata?.traceId ?? "";
  const spanId = ObservabilityService.startSpan(env, traceId, "toolRouter", state);

  const taskIds = state.taskIds ?? [];
  const firstTaskId = taskIds.find(
    (id) => state.taskEntities?.[id]?.requiredTools?.length,
  );

  // ───────────────────────────────────────────────────────────────────
  // Nothing to route – short-circuit.
  // ───────────────────────────────────────────────────────────────────
  if (!firstTaskId) {
    const time = performance.now() - t0;
    ObservabilityService.endSpan(env, traceId, spanId, "toolRouter", state, state, time);
    return {
      ...state,
      metadata: {
        ...state.metadata,
        nodeTimings: { ...state.metadata?.nodeTimings, toolRouter: time },
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Prepare context
  // ───────────────────────────────────────────────────────────────────
  const task = state.taskEntities![firstTaskId];
  const query = task.originalQuery ?? "";
  const availableTools = task.requiredTools!;
  log.info({ firstTaskId, availableTools, query }, "routing task");

  // ───────────────────────────────────────────────────────────────────
  // 1) choose a tool
  // ───────────────────────────────────────────────────────────────────
  const taskTool = await routeTask(
    env,
    task,
    tools.subset(availableTools),
    state.chatHistory,
  );
  if (!taskTool) return {};
  const { toolName, args } = taskTool;


  // ───────────────────────────────────────────────────────────────────
  // 3) update state & telemetry
  // ───────────────────────────────────────────────────────────────────
  const nextState: AgentState = {
    ...state,
    taskEntities: {
      ...state.taskEntities,
      [firstTaskId]: {
        ...task,
        toolToRun: toolName,
        toolParameters: args,
      },
    },
  };

  const time = performance.now() - t0;
  ObservabilityService.endSpan(env, traceId, spanId, "toolRouter", state, nextState, time);

  return {
    taskEntities: {
      ...state.taskEntities,
      [firstTaskId]: {
        ...task,
        toolToRun: toolName,
        toolParameters: args,
      },
    },
    metadata: {
      ...nextState.metadata,
      nodeTimings: { ...nextState.metadata?.nodeTimings, toolRouter: time },
    },
  };
}

/* ------------------------------------------------------------------ *
 * downstream helpers                                                 *
 * ------------------------------------------------------------------ */

/** Single-shot selection + arg extraction */
async function routeTask(
  env: Env,
  task: UserTaskEntity,
  registry: ToolRegistry,
  chatHistory?: MessagePair[],
) {
  if (!task.definition) {
    getLogger().error("No task definition found for routing");
    return;
  }
  const routerSchema = registry.toolUnionSchema();

  const systemPrompt = getToolRoutingPrompt().replace('{{tools}}', `
${registry.list()
      .map(n => {
        const t = registry.get(n.name)!;
        return `### ${n}\n${t.description}\n`;
      })
      .join("\n")}

`);

  const messages = buildMessages(systemPrompt, chatHistory, task.definition);

  const { toolName, args } = await LlmService.invokeStructured<z.infer<typeof routerSchema>>(env, messages, {
    schema: routerSchema,
    schemaInstructions:
      "Return an object { toolName: <string>, args: <object> }",
  });

  return { toolName, args }; // already zod-validated
}

/* ------------------------------------------------------------------ *
 * optional: routeAfterTool (unchanged API)                           *
 * ------------------------------------------------------------------ */

export async function routeAfterTool(
  state: AgentState,
): Promise<"run_tool" | "answer"> {
  const taskIds = state.taskIds ?? [];
  for (const id of taskIds) {
    if (state.taskEntities?.[id]?.toolToRun) return "run_tool";
  }
  return "answer";
}

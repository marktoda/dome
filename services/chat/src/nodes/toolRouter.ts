// src/nodes/toolRouter.ts
import { z } from "zod";
import { getLogger, logError } from "@dome/logging";
import { ObservabilityService } from "../services/observabilityService";
import { LlmService } from "../services/llmService";
import { buildMessages } from "../utils";
import { getToolRoutingPrompt } from "../config/promptsConfig";
import { ToolRegistry } from "../tools";
import {
  AgentState,
  UserTaskEntity,
  MessagePair,
  AIMessage,
} from "../types";

const NONE_TOOL_NAME = "none";

/* ------------------------------------------------------------------ *
 * main node                                                           *
 * ------------------------------------------------------------------ */
export async function toolRouter(
  state: AgentState,
  env: Env,
  registry: ToolRegistry,
): Promise<Partial<AgentState>> {
  const log = getLogger().child({ node: "toolRouter" });
  const started = performance.now();
  const traceId = state.metadata?.traceId ?? "";
  const spanId = ObservabilityService.startSpan(env, traceId, "toolRouter", state);
  const taskIds = state.taskIds ?? [];

  /* ── 2 · build once: schema & prompt template ────────────────────── */
  const routerSchema = registry.toolUnionSchema();
  if (registry.list().length === 0) {
    log.info("Tool registry is empty, skipping routing");
    return {};
  }

  const promptTemplate = getToolRoutingPrompt().replace(
    "{{tools}}",
    registry
      .list()
      .map((t) => `### ${t.name}\n${t.description}\n`)
      .join("\n"),
  );

  /* ── 3 · route every task in parallel ────────────────────────────── */
  const routePromises = taskIds.map(async (id) => {
    const task = state.taskEntities![id];
    try {
      const { toolName, args } = await routeTask(
        env,
        task,
        routerSchema,
        promptTemplate,
        registry,
        state.chatHistory,
      );

      if (toolName === NONE_TOOL_NAME) {
        getLogger().info({ toolName, id }, 'No tool explicitly selected');
        return { id };
      }
      return { id, toolName, args };
    } catch (err) {
      logError(err, `tool routing failed for task ${id}`);
      return null;
    }
  });

  const routed = (await Promise.all(routePromises)).filter(Boolean) as {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
  }[];

  if (routed.length === 0) {
    const elapsed = performance.now() - started;
    ObservabilityService.endSpan(env, traceId, spanId, "toolRouter", state, state, elapsed);
    return {
      metadata: {
        ...state.metadata,
        nodeTimings: { ...state.metadata?.nodeTimings, toolRouter: elapsed },
      },
    };
  }

  /* ── 4 · merge results into taskEntities ─────────────────────────── */
  const newEntities = { ...state.taskEntities };
  for (const { id, toolName, args } of routed) {
    newEntities[id] = {
      ...newEntities[id],
      toolToRun: toolName,
      toolParameters: args,
    };
  }

  const nextStateFragment: Partial<AgentState> = {
    taskEntities: newEntities,
    metadata: {
      ...state.metadata,
      nodeTimings: {
        ...state.metadata?.nodeTimings,
        toolRouter: performance.now() - started,
      },
    },
  };

  ObservabilityService.endSpan(
    env,
    traceId,
    spanId,
    "toolRouter",
    state,
    { ...state, ...nextStateFragment } as AgentState,
    performance.now() - started,
  );

  return nextStateFragment;
}

/* ------------------------------------------------------------------ *
 * helper: one-shot routing for a single task                          *
 * ------------------------------------------------------------------ */
async function routeTask(
  env: Env,
  task: UserTaskEntity,
  routerSchema: z.ZodTypeAny,
  promptTemplate: string,
  registry: ToolRegistry,
  chatHistory?: MessagePair[],
): Promise<{ toolName: string; args: unknown }> {
  if (!task.originalQuery) throw new Error("task.originalQuery missing");

  const systemPrompt = promptTemplate;

  const messages = buildMessages(systemPrompt, chatHistory, task.originalQuery);

  const { toolName, args } = await LlmService.invokeStructured<
    z.infer<typeof routerSchema>
  >(env, messages, {
    schema: routerSchema,
    schemaInstructions: 'Return {"toolName": "...", "args": {...}}',
  });

  return { toolName, args };
}

/* ------------------------------------------------------------------ *
 * unchanged: routeAfterTool                                          *
 * ------------------------------------------------------------------ */
export async function routeAfterTool(
  state: AgentState,
): Promise<"run_tool" | "answer"> {
  return (state.taskIds ?? []).some((id) => state.taskEntities?.[id]?.toolToRun)
    ? "run_tool"
    : "answer";
}

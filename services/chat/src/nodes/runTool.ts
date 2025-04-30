import { logError, getLogger } from "@dome/logging";
import { AgentState, Document, ToolResult } from "../types";
import { ToolRegistry } from "../tools";
import { ObservabilityService } from "../services/observabilityService";

/* ------------------------------------------------------------------ *
 * main node                                                           *
 * ------------------------------------------------------------------ */
export async function runTool(
  state: AgentState,
  env: Env,
  registry: ToolRegistry,
): Promise<Partial<AgentState>> {
  const log = getLogger().child({ node: "runTool" });
  const started = performance.now();
  const traceId = state.metadata?.traceId ?? "";
  const spanId = ObservabilityService.startSpan(env, traceId, "runTool", state);

  /* ── find the first task that still has a tool to run ────────────── */
  const taskId = (state.taskIds ?? []).find(
    (id) => state.taskEntities?.[id]?.toolToRun,
  );
  if (!taskId) {
    log.warn({ traceId, spanId }, "reached runTool but no task pending");
    ObservabilityService.endSpan(env, traceId, spanId, "runTool", state, state, 0);
    return state;
  }

  const task = state.taskEntities![taskId];
  const toolName = task.toolToRun!;
  const argsRaw = task.toolParameters ?? {};
  const userQuery = task.originalQuery ?? task.rewrittenQuery ?? "";

  log.info({ taskId, toolName, argsRaw, traceId, spanId }, "executing tool");

  /* ------------------------------------------------------------------ */
  /* 1 ▸ validate + execute                                             */
  /* ------------------------------------------------------------------ */
  try {
    const tool = registry.get(toolName);
    if (!tool) throw new Error(`tool "${toolName}" not found in registry`);

    // Zod validation + default filling
    const args = tool.inputSchema.parse(argsRaw);

    // Use secure executor (handles sandboxing / timeouts internally)
    const output = await tool.execute(args, env);

    /* ---------------------------------------------------------------- */
    /* 2 ▸ convert to docs + score                                      */
    /* ---------------------------------------------------------------- */
    const docs = toolOutputToDocuments(toolName, output);
    log.info({ docs, toolName }, "tool output converted to documents");

    const result: ToolResult = {
      toolName,
      input: args,
      output,
      executionTimeMs: performance.now() - started,
    };

    /* ---------------------------------------------------------------- */
    /* 3 ▸ update state                                                 */
    /* ---------------------------------------------------------------- */
    const nextState: AgentState = {
      ...state,
      docs: [...(state.docs ?? []), ...docs],
      taskEntities: {
        ...state.taskEntities,
        [taskId]: {
          ...task,
          toolResults: [...(task.toolResults ?? []), result],
          toolToRun: undefined,            // mark as executed
        },
      },
    };

    const elapsed = performance.now() - started;
    ObservabilityService.endSpan(env, traceId, spanId, "runTool", state, nextState, elapsed);
    ObservabilityService.logEvent(env, traceId, spanId, "tool_execution_complete", {
      taskId, toolName, executionTimeMs: elapsed,
    });

    return {
      ...nextState,
      metadata: {
        ...nextState.metadata,
        nodeTimings: { ...nextState.metadata?.nodeTimings, runTool: elapsed },
      },
    };
  } catch (err) {
    /* ---------------------------------------------------------------- */
    /* 4 ▸ error handling + optional fallback                           */
    /* ---------------------------------------------------------------- */
    logError(err, 'tool execution vailed', { taskId, toolName, traceId, spanId });


    return {};
  }
}


/**
 * Very small, generic conversion:
 *  • string              → one doc (plain-text)
 *  • array               → 1 doc per item (stringified if not string)
 *  • everything else     → one doc with JSON.stringify(body, 2)
 *
 * No per-tool special-cases; metadata is lightweight but consistent.
 */
export function toolOutputToDocuments(
  toolName: string,
  output: unknown,
): Document[] {
  const createdAt = new Date().toISOString();
  // TODO: fix relevance score
  const baseMeta = {
    source: "tool",
    createdAt,
    relevanceScore: 0.9,
  };

  // ── 1 · string ────────────────────────────────────────────────────
  if (typeof output === "string") {
    return [
      {
        id: `tool-${toolName}-${crypto.randomUUID()}`,
        title: `${toolName} result`,
        body: output,
        metadata: { ...baseMeta, mimeType: "text/plain" },
      },
    ];
  }

  // ── 2 · array (string or object) ─────────────────────────────────
  if (Array.isArray(output)) {
    return output.map((item, idx) => ({
      id: `tool-${toolName}-${idx}-${crypto.randomUUID()}`,
      title: `${toolName} result #${idx + 1}`,
      body: typeof item === "string" ? item : JSON.stringify(item, null, 2),
      metadata: {
        ...baseMeta,
        mimeType: typeof item === "string" ? "text/plain" : "application/json",
      },
    }));
  }

  // ── 3 · object / fallback ────────────────────────────────────────
  return [
    {
      id: `tool-${toolName}-${crypto.randomUUID()}`,
      title: `${toolName} result`,
      body: JSON.stringify(output, null, 2),
      metadata: { ...baseMeta, mimeType: "application/json" },
    },
  ];
}

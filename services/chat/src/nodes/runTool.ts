import { getLogger, logError } from "@dome/logging";
import { ObservabilityService } from "../services/observabilityService";
import { ToolRegistry } from "../tools";
import { AgentState, Document, ToolResult } from "../types";

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

  /* ── 1 · gather all tasks that still need execution ──────────────── */
  const pendingIds = (state.taskIds ?? []).filter(
    (id) => state.taskEntities?.[id]?.toolToRun,
  );

  if (pendingIds.length === 0) {
    ObservabilityService.endSpan(env, traceId, spanId, "runTool", state, state, 0);
    return {};
  }

  /* ── 2 · execute all tools in parallel ───────────────────────────── */
  const execPromises = pendingIds.map(async (id) => {
    const task = state.taskEntities![id];
    const toolName = task.toolToRun!;
    const rawArgs = task.toolParameters ?? {};

    try {
      const tool = registry.get(toolName);
      if (!tool) throw new Error(`tool "${toolName}" not in registry`);

      const args = tool.inputSchema.parse(rawArgs);          // zod validate
      const output = await tool.execute(args, env);            // run tool

      const docs = toolOutputToDocuments(toolName, output);

      const result: ToolResult = {
        toolName,
        input: args,
        output,
        executionTimeMs: 0,   // ignored in diff; could measure per-tool
      };

      return { id, docs, result };
    } catch (err) {
      logError(err, `tool ${toolName} failed`, { id, traceId, spanId });
      return null; // skip on error; could push fallback docs/results here
    }
  });

  const finished = (await Promise.all(execPromises)).filter(Boolean) as {
    id: string;
    docs: Document[];
    result: ToolResult;
  }[];

  if (finished.length === 0) {
    ObservabilityService.endSpan(env, traceId, spanId, "runTool", state, state, 0);
    return {};
  }

  /* ── 3 · build diff fragment for LLM graph state  ────────────────── */
  const entityUpdates: Record<string, any> = { ...state.taskEntities };

  for (const { id, docs, result } of finished) {
    entityUpdates[id] = {
      ...entityUpdates[id],
      toolToRun: undefined,
      toolResults: [...(entityUpdates[id].toolResults ?? []), result],
    };
  }

  const elapsed = performance.now() - started;
  ObservabilityService.endSpan(
    env,
    traceId,
    spanId,
    "runTool",
    state,
    { ...state, taskEntities: entityUpdates },
    elapsed,
  );

  return {
    taskEntities: entityUpdates,
    metadata: {
      ...state.metadata,
      nodeTimings: { ...state.metadata?.nodeTimings, runTool: elapsed },
    },
  };
}

/* ------------------------------------------------------------------ *
 * generic output → documents helper (unchanged)                       *
 * ------------------------------------------------------------------ */
export function toolOutputToDocuments(
  toolName: string,
  output: unknown,
): Document[] {
  const createdAt = new Date().toISOString();
  const baseMeta = { source: "tool", createdAt, relevanceScore: 0.9 };

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

  return [
    {
      id: `tool-${toolName}-${crypto.randomUUID()}`,
      title: `${toolName} result`,
      body: JSON.stringify(output, null, 2),
      metadata: { ...baseMeta, mimeType: "application/json" },
    },
  ];
}

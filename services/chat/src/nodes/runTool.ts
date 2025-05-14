import { getLogger, logError } from '@dome/common';
import { ObservabilityService } from '../services/observabilityService';
import { ToolRegistry } from '../tools';
import { Document, ToolResult } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import type { SliceUpdate } from '../types/stateSlices';
import { toDomeError } from '../utils/errors';

/**
 * Run Tool Node
 *
 * Executes selected tools and stores clearly labeled results.
 * This node is responsible for executing the tools selected by the toolRouterLLM
 * and processing their outputs for use in later stages of the RAG pipeline.
 *
 * The node:
 * 1. Takes tool selection from toolRouterLLM
 * 2. Executes the selected tools with appropriate parameters
 * 3. Handles potential errors in tool execution
 * 4. Stores results with clear labeling of source and content
 * 5. Updates agent state with tool execution results
 *
 * This node bridges between the RAG pipeline decision making and external
 * information sources, allowing the system to augment retrieved information
 * with real-time data from tools.
 *
 * @param state Current agent state
 * @param env Environment bindings
 * @param registry Tool registry containing available tools
 * @returns Updated agent state with tool execution results
 */

/* ------------------------------------------------------------------ *
 * main node                                                           *
 * ------------------------------------------------------------------ */
export type RunToolUpdate = SliceUpdate<'taskEntities' | 'docs'>;

export async function runTool(
  state: AgentState,
  env: Env,
  registry: ToolRegistry,
): Promise<RunToolUpdate> {
  const log = getLogger().child({ node: 'runTool' });
  const started = performance.now();
  const traceId = state.metadata?.traceId ?? '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'runTool', state);

  /* ── 1 · gather all tasks that still need execution ──────────────── */
  const pendingIds = (state.taskIds ?? []).filter(id => state.taskEntities?.[id]?.toolToRun);

  if (pendingIds.length === 0) {
    const elapsed = performance.now() - started;
    ObservabilityService.endSpan(env, traceId, spanId, 'runTool', state, state, elapsed);
    log.info('No tools to run, skipping execution');
    return {
      metadata: {
        currentNode: 'runTool',
        executionTimeMs: elapsed,
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          runTool: elapsed,
        },
      },
    };
  }

  /* ── 2 · execute all tools in parallel ───────────────────────────── */
  const execPromises = pendingIds.map(async id => {
    const task = state.taskEntities![id];
    const toolName = task.toolToRun!;
    const rawArgs = task.toolParameters ?? {};

    try {
      const tool = registry.get(toolName);
      if (!tool) throw new Error(`tool "${toolName}" not in registry`);

      const args = tool.inputSchema.parse(rawArgs); // zod validate
      const output = await tool.execute(args, env); // run tool

      const docs = toolOutputToDocuments(toolName, output);

      // Calculate execution time for this specific tool
      const toolExecutionTimeMs = performance.now() - started;

      const result: ToolResult = {
        toolName,
        input: args,
        output,
        executionTimeMs: toolExecutionTimeMs,
      };

      // Log successful tool execution
      log.info(
        {
          toolName,
          taskId: id,
          executionTimeMs: toolExecutionTimeMs,
        },
        'Tool execution successful',
      );

      // Log event in observability
      ObservabilityService.logEvent(env, traceId, spanId, 'tool_execution', {
        toolName,
        taskId: id,
        executionTimeMs: toolExecutionTimeMs,
        outputType: typeof output,
      });

      return { id, docs, result };
    } catch (err) {
      const domeError = toDomeError(err);
      logError(domeError, `tool ${toolName} failed`, { id, traceId, spanId });

      // Add error information to tool results
      const errorResult: ToolResult = {
        toolName,
        input: rawArgs,
        output: `Error executing tool: ${domeError.message}`,
        executionTimeMs: performance.now() - started,
        error: domeError.message,
      };

      // Create a document from the error for transparency
      const errorDocs: Document[] = [
        {
          id: `tool-error-${toolName}-${crypto.randomUUID()}`,
          title: `Error executing ${toolName}`,
          content: `Failed to execute tool ${toolName}: ${domeError.message}`,
          metadata: {
            source: 'tool_error',
            sourceType: 'tool_error',
            createdAt: new Date().toISOString(),
            relevanceScore: 0.5,
            mimeType: 'text/plain',
          },
        },
      ];

      // Return the error information for processing
      return { id, docs: errorDocs, result: errorResult, error: domeError };
    }
  });

  const finished = (await Promise.all(execPromises)).filter(Boolean) as {
    id: string;
    docs: Document[];
    result: ToolResult;
  }[];

  if (finished.length === 0) {
    const elapsed = performance.now() - started;
    ObservabilityService.endSpan(env, traceId, spanId, 'runTool', state, state, elapsed);

    // Format error if no tools completed successfully
    const formattedError = {
      node: 'runTool',
      message: 'All tool executions failed',
      timestamp: Date.now(),
    };

    return {
      metadata: {
        currentNode: 'runTool',
        executionTimeMs: elapsed,
        errors: [...(state.metadata?.errors || []), formattedError],
        nodeTimings: {
          ...state.metadata?.nodeTimings,
          runTool: elapsed,
        },
      },
    };
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
    'runTool',
    state,
    { ...state, taskEntities: entityUpdates },
    elapsed,
  );

  // Collect all documents from tool executions
  const toolDocs = finished.flatMap(item => item.docs || []);

  // Log summary of tool executions
  log.info(
    {
      completedTools: finished.map(item => item.result.toolName),
      totalTools: finished.length,
      totalDocs: toolDocs.length,
    },
    'Tool executions completed',
  );

  return {
    taskEntities: entityUpdates,
    // Add all tool-generated documents to the state
    docs: [...(state.docs || []), ...toolDocs],
    // Tool results are already stored in taskEntities
    metadata: {
      ...state.metadata,
      currentNode: 'runTool',
      executionTimeMs: elapsed,
      nodeTimings: { ...state.metadata?.nodeTimings, runTool: elapsed },
    },
  };
}

/* ------------------------------------------------------------------ *
 * generic output → documents helper                                   *
 * ------------------------------------------------------------------ */
export function toolOutputToDocuments(toolName: string, output: unknown): Document[] {
  const createdAt = new Date().toISOString();
  const baseMeta = {
    source: 'tool',
    sourceType: `tool_${toolName}`,
    createdAt,
    relevanceScore: 0.1,
  };

  if (typeof output === 'string') {
    return [
      {
        id: `tool-${toolName}-${crypto.randomUUID()}`,
        title: `${toolName} result`,
        content: output,
        metadata: { ...baseMeta, mimeType: 'text/plain' },
      },
    ];
  }

  if (Array.isArray(output)) {
    return output.map((item, idx) => ({
      id: `tool-${toolName}-${idx}-${crypto.randomUUID()}`,
      title: `${toolName} result #${idx + 1}`,
      content: typeof item === 'string' ? item : JSON.stringify(item, null, 2),
      metadata: {
        ...baseMeta,
        mimeType: typeof item === 'string' ? 'text/plain' : 'application/json',
      },
    }));
  }

  return [
    {
      id: `tool-${toolName}-${crypto.randomUUID()}`,
      title: `${toolName} result`,
      content: JSON.stringify(output, null, 2),
      metadata: { ...baseMeta, mimeType: 'application/json' },
    },
  ];
}

// src/nodes/toolRouter.ts
import { z } from 'zod';
import { getLogger, logError } from '@dome/common';
import { ObservabilityService } from '../services/observabilityService';
import { LlmService } from '../services/llmService';
import { buildMessages } from '../utils';
import { getToolRoutingPrompt } from '../config/promptsConfig';
import { ToolRegistry } from '../tools';
import type { UserTaskEntity, MessagePair } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import type { SliceUpdate } from '../types/stateSlices';

const NONE_TOOL_NAME = 'none';

/* ------------------------------------------------------------------ *
 *  Public node                                                         *
 * ------------------------------------------------------------------ */
export type ToolRouterUpdate = SliceUpdate<'taskEntities'>;

export async function toolRouter(
  state: AgentState,
  env: Env,
  registry: ToolRegistry,
): Promise<ToolRouterUpdate> {
  const log = getLogger().child({ node: 'toolRouter' });
  const started = performance.now();
  const traceId = state.metadata?.traceId ?? '';
  const spanId = ObservabilityService.startSpan(env, traceId, 'toolRouter', state);

  /* ------------------------------------------------------------------ */
  /*  Fast-path exits                                                   */
  /* ------------------------------------------------------------------ */
  const taskIds = state.taskIds ?? [];
  if (taskIds.length === 0 || registry.list().length === 0) {
    log.info('No tasks or registry empty – nothing to route');
    return { taskEntities: {} };
  }

  /* ------------------------------------------------------------------ */
  /*  Build once: schema & prompt                                       */
  /* ------------------------------------------------------------------ */
  const routerSchema = registry.toolUnionSchema();
  const promptTemplate = getToolRoutingPrompt().replace(
    '{{tools}}',
    registry
      .list()
      .map(t => `### ${t.name}\n${t.description}\n`)
      .join('\n'),
  );

  /* ------------------------------------------------------------------ */
  /*  Route every task in parallel                                      */
  /* ------------------------------------------------------------------ */
  const routePromises = taskIds.map(async id => {
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

      if (toolName === NONE_TOOL_NAME) return { id }; // explicit "no-tool" choice
      return { id, toolName, args };
    } catch (err) {
      logError(err, `tool routing failed for task ${id}`);
      return null;
    }
  });

  const routed = (await Promise.all(routePromises)).filter(Boolean) as Array<{
    id: string;
    toolName?: string;
    args?: Record<string, unknown>;
  }>;

  /* ------------------------------------------------------------------ */
  /*  Nothing routed?                                                   */
  /* ------------------------------------------------------------------ */
  if (routed.length === 0) {
    const elapsed = performance.now() - started;
    ObservabilityService.endSpan(env, traceId, spanId, 'toolRouter', state, state, elapsed);
    return {
      metadata: {
        ...state.metadata,
        nodeTimings: { ...state.metadata?.nodeTimings, toolRouter: elapsed },
      },
      taskEntities: {},
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Merge results back into taskEntities                              */
  /* ------------------------------------------------------------------ */
  const updatedEntities = { ...state.taskEntities };
  for (const { id, toolName, args } of routed) {
    if (!toolName) continue; // no-tool choice – leave entity untouched
    updatedEntities[id] = {
      ...updatedEntities[id],
      toolToRun: toolName,
      toolParameters: args,
    };
  }

  const elapsed = performance.now() - started;
  const fragment: ToolRouterUpdate = {
    taskEntities: updatedEntities,
    metadata: {
      ...state.metadata,
      nodeTimings: { ...state.metadata?.nodeTimings, toolRouter: elapsed },
    },
  };

  ObservabilityService.endSpan(
    env,
    traceId,
    spanId,
    'toolRouter',
    state,
    { ...state, ...fragment } as AgentState,
    elapsed,
  );

  return fragment;
}

/* ------------------------------------------------------------------ *
 *  Helper – one-shot routing for a single task                         *
 * ------------------------------------------------------------------ */
async function routeTask(
  env: Env,
  task: UserTaskEntity,
  routerSchema: z.ZodTypeAny,
  promptTemplate: string,
  _registry: ToolRegistry, // kept for future use (e.g. examples)
  chatHistory?: MessagePair[],
): Promise<{ toolName: string; args: unknown }> {
  if (!task.originalQuery) throw new Error('task.originalQuery missing');

  const messages = buildMessages(promptTemplate, chatHistory, task.originalQuery);

  const { toolName, args } = await LlmService.invokeStructured<z.infer<typeof routerSchema>>(
    env,
    messages,
    {
      schema: routerSchema,
      schemaInstructions: 'Return {"toolName": "...", "args": {...}}',
    },
  );

  return { toolName, args };
}

/* ------------------------------------------------------------------ *
 *  Tiny util used by graph edge routing                               *
 * ------------------------------------------------------------------ */
export async function routeAfterTool(state: AgentState): Promise<'run_tool' | 'answer'> {
  return (state.taskIds ?? []).some(id => state.taskEntities?.[id]?.toolToRun)
    ? 'run_tool'
    : 'answer';
}

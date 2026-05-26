// Workflow runner backed by the Vercel AI SDK.
//
// The SDK owns the agentic step loop (tool calls + intermediate steps); we
// only build a `system` prompt from the workflow definition, expose the
// declared tool subset to the model, and surface the final result back to
// callers. See docs/wiki/specs/prompts-and-workflows.md §"Runner".

import { generateText, tool, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

import type { Vault } from "../vault";
import { WorkflowRegistry } from "../prompts/registry";
import type { WorkflowName } from "./workflow-name";
import {
  readDocumentInput,
  writeDocumentInput,
  appendLogInput,
  searchIndexInput,
  wikilinkResolveInput,
  moveDocumentInput,
  deleteDocumentInput,
  compactWriteDocumentInput,
  compactAppendLogInput,
  compactSearchIndexInput,
} from "../tools/schemas";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_STEPS = 50;

export interface RunWorkflowOpts {
  /** Override the LLM. Pass a model id string, or a fully-constructed LanguageModel (useful for tests). */
  model?: string | LanguageModel;
  /** Hard cap on agentic steps; defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
}

export interface RunWorkflowResult {
  text: string;
  toolCallCount: number;
  /** AI SDK's unified finish reason (e.g. "stop", "tool-calls", "length"). */
  finishReason: string;
  /** Total number of agentic steps the SDK ran. */
  steps: number;
}

/**
 * Run a workflow against the model. Resolves the workflow's prompt body and
 * declared tool subset, then hands control to `generateText` which drives
 * the tool-call loop up to {@link DEFAULT_MAX_STEPS} (override via `opts.maxSteps`).
 *
 * `userMessage` becomes the SDK `prompt`. The workflow body becomes `system`.
 */
export async function runWorkflow(
  vault: Vault,
  workflowName: WorkflowName,
  userMessage: string,
  opts: RunWorkflowOpts = {},
): Promise<RunWorkflowResult> {
  const registry = new WorkflowRegistry(vault);
  const def = await registry.get(workflowName);
  if (!def) throw new Error(`workflow not found: ${workflowName}`);

  const tools = buildAiSdkTools(vault, def.frontmatter.tools);
  const modelArg = opts.model ?? DEFAULT_MODEL;
  const model: LanguageModel = typeof modelArg === "string" ? anthropic(modelArg) : modelArg;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  const result = await generateText({
    model,
    system: def.body,
    prompt: userMessage,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });

  return {
    text: result.text,
    toolCallCount: result.toolCalls.length,
    finishReason: result.finishReason,
    steps: result.steps.length,
  };
}

/**
 * Build the AI SDK tool set for a workflow, filtered to the tools the workflow
 * declares in its frontmatter `tools:` list. Exposed for testing.
 *
 * The full SDK tool catalog is constructed up-front; we then select the
 * entries the workflow allows. Unknown names are silently dropped.
 */
export function buildAiSdkTools(
  vault: Vault,
  allowedToolNames: ReadonlyArray<string>,
): ToolSet {
  const all: ToolSet = allToolDefinitions(vault);
  const out: ToolSet = {};
  for (const name of allowedToolNames) {
    const t = all[name];
    if (t !== undefined) out[name] = t;
  }
  return out;
}

// ----- Tool definitions ----------------------------------------------------
// Zod schemas + compaction helpers live in src/tools/schemas.ts (single source
// of truth shared with the MCP adapter layer). Here we wrap each schema as an
// AI SDK `tool({...})` and bind it to the Vault.

function allToolDefinitions(vault: Vault): ToolSet {
  return {
    readDocument: tool({
      description: "Read a Document by path.",
      inputSchema: readDocumentInput,
      execute: async (input) => vault.tools.readDocument(input),
    }),
    writeDocument: tool({
      description: "Create or update a Document. Refuses raw/ paths.",
      inputSchema: writeDocumentInput,
      execute: async (input) => vault.tools.writeDocument(compactWriteDocumentInput(input)),
    }),
    appendLog: tool({
      description: "Append an entry to log.md.",
      inputSchema: appendLogInput,
      execute: async (input) => vault.tools.appendLog(compactAppendLogInput(input)),
    }),
    searchIndex: tool({
      description: "Search the index + page bodies for matches.",
      inputSchema: searchIndexInput,
      execute: async (input) => vault.tools.searchIndex(compactSearchIndexInput(input)),
    }),
    wikilinkResolve: tool({
      description: "Resolve a full-path wikilink to a Document or null.",
      inputSchema: wikilinkResolveInput,
      execute: async (input) => vault.tools.wikilinkResolve(input),
    }),
    moveDocument: tool({
      description: "Move a Document; atomically rewrites incoming wikilinks.",
      inputSchema: moveDocumentInput,
      execute: async (input) => vault.tools.moveDocument(input),
    }),
    deleteDocument: tool({
      description: "Delete a Document.",
      inputSchema: deleteDocumentInput,
      execute: async (input) => vault.tools.deleteDocument(input),
    }),
  };
}

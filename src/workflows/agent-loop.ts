// Workflow runner backed by the Vercel AI SDK.
//
// The SDK owns the agentic step loop (tool calls + intermediate steps); we
// only build a `system` prompt from the workflow definition, expose the
// declared tool subset to the model, and surface the final result back to
// callers. See docs/wiki/specs/prompts-and-workflows.md §"Runner".

import { generateText, tool, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import type { Vault } from "../vault";
import { WorkflowRegistry } from "../prompts/registry";
import type { WorkflowName } from "./workflow-name";
import type { CreationReason, LogVerb, Sensitivity } from "../types";
import type { WriteDocumentInput, WriteDocumentOpts } from "../tools/write-document";
import type { AppendLogInput } from "../tools/append-log";
import type { SearchIndexInput } from "../tools/search-index";

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
// These mirror the Zod schemas in src/mcp/tool-adapters.ts. We keep them
// duplicated rather than imported because the MCP adapter layer goes through
// JSON-Schema for the MCP protocol while the AI SDK consumes the Zod schemas
// directly with type inference; the two boundaries have subtly different
// shape requirements (exactOptionalPropertyTypes compaction, etc.).

function allToolDefinitions(vault: Vault): ToolSet {
  return {
    readDocument: tool({
      description: "Read a Document by path.",
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => vault.tools.readDocument(input),
    }),
    writeDocument: tool({
      description: "Create or update a Document. Refuses raw/ paths.",
      inputSchema: z.object({
        path: z.string(),
        body: z.string(),
        frontmatter: z.record(z.string(), z.unknown()),
        opts: z
          .object({
            create: z.boolean().optional(),
            reason: z.enum(["recurring", "named_explicitly", "structural"]).optional(),
            sensitivity_classified: z.enum(["normal", "sensitive"]).optional(),
          })
          .optional(),
      }),
      execute: async (input) => {
        const compact: WriteDocumentInput = {
          path: input.path,
          body: input.body,
          frontmatter: input.frontmatter,
        };
        if (input.opts) {
          const opts: WriteDocumentOpts = {};
          if (input.opts.create !== undefined) opts.create = input.opts.create;
          if (input.opts.reason !== undefined) opts.reason = input.opts.reason as CreationReason;
          if (input.opts.sensitivity_classified !== undefined) {
            opts.sensitivity_classified = input.opts.sensitivity_classified as Sensitivity;
          }
          compact.opts = opts;
        }
        return vault.tools.writeDocument(compact);
      },
    }),
    appendLog: tool({
      description: "Append an entry to log.md.",
      inputSchema: z.object({
        verb: z.string(),
        subject: z.string(),
        body: z.string().optional(),
        refs: z.array(z.string()).optional(),
      }),
      execute: async (input) => {
        const compact: AppendLogInput = { verb: input.verb as LogVerb, subject: input.subject };
        if (input.body !== undefined) compact.body = input.body;
        if (input.refs !== undefined) compact.refs = input.refs;
        return vault.tools.appendLog(compact);
      },
    }),
    searchIndex: tool({
      description: "Search the index + page bodies for matches.",
      inputSchema: z.object({
        query: z.string(),
        filters: z
          .object({
            category: z.string().optional(),
            type: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
          .optional(),
      }),
      execute: async (input) => {
        const compact: SearchIndexInput = { query: input.query };
        if (input.filters) {
          const filters: { category?: string; type?: string; tags?: string[] } = {};
          if (input.filters.category !== undefined) filters.category = input.filters.category;
          if (input.filters.type !== undefined) filters.type = input.filters.type;
          if (input.filters.tags !== undefined) filters.tags = input.filters.tags;
          compact.filters = filters;
        }
        return vault.tools.searchIndex(compact);
      },
    }),
    wikilinkResolve: tool({
      description: "Resolve a full-path wikilink to a Document or null.",
      inputSchema: z.object({ link: z.string() }),
      execute: async (input) => vault.tools.wikilinkResolve(input),
    }),
    moveDocument: tool({
      description: "Move a Document; atomically rewrites incoming wikilinks.",
      inputSchema: z.object({ from: z.string(), to: z.string(), reason: z.string() }),
      execute: async (input) => vault.tools.moveDocument(input),
    }),
    deleteDocument: tool({
      description: "Delete a Document.",
      inputSchema: z.object({ path: z.string(), reason: z.string() }),
      execute: async (input) => vault.tools.deleteDocument(input),
    }),
  };
}

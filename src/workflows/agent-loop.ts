// Workflow runner backed by the Vercel AI SDK.
//
// The SDK owns the agentic step loop (tool calls + intermediate steps); we
// only build a `system` prompt from the workflow definition, expose the
// declared tool subset to the model, and surface the final result back to
// callers. See docs/wiki/specs/prompts-and-workflows.md §"Runner".

import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

import type { Vault } from "../vault";
import { WorkflowRegistry } from "../prompts/registry";
import type { WorkflowName } from "./workflow-name";
import { commitWorkflow } from "../workflow-commit";
import { MUTATING_TOOL_NAMES, filterAiTools } from "../tools/registry";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_STEPS = 50;

export interface RunWorkflowOpts {
  /** Override the LLM. Pass a model id string, or a fully-constructed LanguageModel (useful for tests). */
  model?: string | LanguageModel;
  /** Hard cap on agentic steps; defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
  /**
   * Disable the per-workflow atomic commit. Defaults to false (commit on
   * success). Tests that just want to assert the LLM path without touching
   * git can pass true. Production callers leave it unset — substrate's
   * load-bearing per-workflow-atomic-commit policy assumes commits happen.
   */
  skipCommit?: boolean;
}

export interface RunWorkflowResult {
  text: string;
  toolCallCount: number;
  /** AI SDK's unified finish reason (e.g. "stop", "tool-calls", "length"). */
  finishReason: string;
  /** Total number of agentic steps the SDK ran. */
  steps: number;
  /**
   * SHA of the per-workflow atomic commit, or "" when nothing was touched
   * or commits are disabled via vault config / opts.skipCommit. The substrate
   * (hooks.md §"Commit policy") relies on commits aligning with log.md
   * entries; the caller can use this SHA to cross-reference.
   */
  commitSha: string;
}

/**
 * Run a workflow against the model. Resolves the workflow's prompt body and
 * declared tool subset, then hands control to `generateText` which drives
 * the tool-call loop up to {@link DEFAULT_MAX_STEPS} (override via `opts.maxSteps`).
 *
 * `userMessage` becomes the SDK `prompt`. The workflow body becomes `system`.
 * An empty `userMessage` is substituted with a synthetic kickoff turn, because
 * the Anthropic Messages API rejects empty text content blocks. Self-driving
 * workflows (lint, migrate dry-run) carry all their instructions in `system`
 * and only need the user turn as an anchor.
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

  const tools = filterAiTools(vault.aiTools, def.frontmatter.tools);
  const modelArg = opts.model ?? DEFAULT_MODEL;
  const model: LanguageModel = typeof modelArg === "string" ? anthropic(modelArg) : modelArg;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  const prompt = userMessage.length > 0 ? userMessage : "Begin.";

  const result = await generateText({
    model,
    system: def.body,
    prompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });

  // Per-workflow atomic commit per docs/wiki/specs/hooks.md §"Commit policy":
  // every workflow's effects + log.md entry land as ONE git commit whose
  // subject is "<verb>: <subject>". Without this, log.md and git log drift —
  // log.md grows with every appendLog effect but git history doesn't, so
  // crash recovery and the "git revert == universal undo" promise break.
  //
  // Skip the commit when no mutations happened — a query workflow that only
  // reads should not produce empty commits.
  let commitSha = "";
  const touchedPaths = collectTouchedPaths(result);
  if (!opts.skipCommit && touchedPaths.length > 0) {
    // log.md + index.md are touched implicitly via the dispatcher whenever
    // ANY mutation happens (appendLog by every mutating Tool;
    // auto-update-index by every wiki write). workflow-commit's git add is
    // tolerant of missing files, so adding them unconditionally is safe.
    const commitPaths = [...touchedPaths, "log.md", "index.md"];
    commitSha = await commitWorkflow(vault, {
      verb: workflowName,
      subject: subjectFromUserMessage(userMessage),
      touchedPaths: commitPaths,
    });
  }

  // AI SDK v6's `result.toolCalls` reflects only the FINAL step's tool calls
  // (zero after a successful tool-call -> tool-result -> text-stop sequence).
  // Per-step tool calls live on result.steps[i].toolCalls — sum them for the
  // total count callers actually want.
  const toolCallCount = result.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);

  return {
    text: result.text,
    toolCallCount,
    finishReason: result.finishReason,
    steps: result.steps.length,
    commitSha,
  };
}

/**
 * Walk the AI SDK result's per-step toolCalls and collect every path the
 * model touched via a mutating Tool. The set drives the per-workflow git
 * commit's `git add` list; non-mutating Tools (read, search, resolve) are
 * skipped.
 */
function collectTouchedPaths(result: Awaited<ReturnType<typeof generateText>>): string[] {
  const paths = new Set<string>();
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      if (!(MUTATING_TOOL_NAMES as ReadonlySet<string>).has(call.toolName)) continue;
      const args = call.input as { path?: string; from?: string; to?: string };
      // writeDocument / deleteDocument / appendLog: `path` or no path (appendLog
      // writes log.md exclusively, covered by the log.md add below).
      if (args.path !== undefined) paths.add(args.path);
      // moveDocument touches both endpoints; the `from` is removed and `to`
      // is added, but both are part of the commit.
      if (args.from !== undefined) paths.add(args.from);
      if (args.to !== undefined) paths.add(args.to);
    }
  }
  return [...paths];
}

/**
 * Derive the commit subject from the user message. The first 60 chars of
 * the first non-empty line is the canonical short form; longer descriptions
 * land in the commit body if a future caller wants them.
 */
function subjectFromUserMessage(userMessage: string): string {
  const firstLine = userMessage.split("\n").find(line => line.trim().length > 0) ?? "(no subject)";
  const trimmed = firstLine.trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed;
}

/**
 * Build the AI SDK tool set for a workflow, filtered to the tools the
 * workflow declares in its frontmatter `tools:` list. Exposed for tests.
 *
 * Now a one-liner over `vault.aiTools` (the registry-bound canonical set):
 * adding an 8th Tool to `src/tools/registry.ts` makes it available here for
 * free.
 */
export function buildAiSdkTools(vault: Vault, allowedToolNames: ReadonlyArray<string>): ToolSet {
  return filterAiTools(vault.aiTools, allowedToolNames);
}

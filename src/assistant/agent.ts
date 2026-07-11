// src/assistant/agent.ts
//
// Orchestration entry-point for the agent backend.
//
// Runs a multi-step, tool-calling agent loop via the Vercel AI SDK's
// streamText(). Provider stream parts remain inside the AgentRuntime adapter;
// citations gathered by tools are returned alongside the stream.

import {
  streamText,
  stepCountIs,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type TextStreamPart,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Vault } from "../vault";
import type { Capability } from "../capabilities";
import { buildAgentTools, type AgentActionContext } from "./tools";
import type {
  AgentChange,
  AgentMessage,
  Citation,
} from "./types";

/** Default interactive-ask model. Overridable via opts.modelId. */
export const DEFAULT_MODEL = "claude-sonnet-4-5";

const AGENT_CHARTER = [
  "You are the owner's second-brain assistant. Answer using ONLY their vault.",
  "Use read_document directly when you know the path. Use run_view when an installed compiled view helps discover or summarize adopted state, then inspect its cited source documents before important claims or edits. Do NOT narrate your tool use — never write 'let me read…', 'I'll search…', or describe your steps. Output only the answer itself.",
  "Ground every claim in the vault. If the vault does not contain the answer, say so plainly — never invent.",
  "Be brief: lead with the direct answer in 1–3 sentences, then only essential detail. Prefer plain prose; use a short markdown list only when it genuinely helps.",
  "Format as clean markdown — blank lines between paragraphs and before any list. Never emit a heading marker (#) mid-sentence. The app displays your sources separately, so do not clutter the prose with file paths or [bracketed] citations.",
].join(" ");

const ACTION_CHARTER = [
  "You can also ACT on the vault when asked: capture_note saves a thought to the inbox, settle_task closes/defers a task, resolve_question answers an owner-directed open question, list_agent_work/complete_agent_work investigate source-backed agent-safe decisions, and list_proposals/apply_proposal/reject_proposal review pending garden edits.",
  "For agent work, read every required evidence path before completing it. The completion tool uses only sources actually read during this turn and rejects stale or ungrounded answers.",
  "These are decisions, not authoring — use them when the owner asks you to do something, not just to answer.",
  "Never invent an id or anchor: look it up first with an appropriate installed view or source document (and list_proposals for proposal ids).",
  "After acting, state plainly what you did (e.g. 'Closed the task', 'Applied proposal 3') in one short sentence.",
].join(" ");

const WRITE_CHARTER = [
  "You can also modify the vault. Use create_document for a new page and edit_document for a surgical, unique-substring edit to an existing page (e.g. checking off a task: '- [ ]' → '- [x]').",
  "Make the smallest change that satisfies the request, then briefly state what you changed. Never write under .dome/.",
].join(" ");

/** Options for the built-in streaming provider adapter. */
export type AgentOptions = {
  readonly vault: Vault;
  readonly question: string;
  readonly modelId?: string | undefined;
  /** Injectable model for tests; defaults to anthropic(modelId ?? DEFAULT_MODEL). */
  readonly model?: LanguageModel | undefined;
  readonly maxSteps?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /** Prior prose turns supplied by the session-owning AgentRuntime. */
  readonly history?: ReadonlyArray<AgentMessage> | undefined;
  /**
   * The granted capability set — the same vocabulary the HTTP routes gate on
   * (`grantedCapabilities` in src/capabilities.ts). Drives which contract
   * tools buildAgentTools provisions: `capture` → capture_note, `resolve` →
   * settle/resolve/apply/reject, `read` → list_proposals, `author` → the
   * write tools.
   */
  readonly capabilities?: ReadonlySet<Capability> | undefined;
};

/**
 * Resolve the built-in agent-loop setup — charter, citation carrier, tool set,
 * model, and step budget — before the provider stream begins.
 */
function setupAgent(opts: AgentOptions): {
  readonly model: LanguageModel;
  readonly system: string;
  readonly messages: ModelMessage[];
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly citations: Citation[];
  readonly changes: AgentChange[];
  readonly abortSignal: AbortSignal | undefined;
} {
  const citations: Citation[] = [];
  const changes: AgentChange[] = [];
  const modelId = opts.modelId ?? DEFAULT_MODEL;
  const capabilities = new Set<Capability>(opts.capabilities ?? []);
  const action: AgentActionContext | undefined =
    capabilities.size > 0
      ? { vaultPath: opts.vault.path, modelId, changes, capabilities }
      : undefined;
  // The contract tools are provisioned when any of their gating capabilities
  // is present; the charter teaches them only when they exist.
  const hasActionTools = ["capture", "resolve", "read"].some((cap) =>
    capabilities.has(cap as Capability),
  );
  const installedViews = opts.vault.listViews();
  const viewCharter = installedViews.length === 0
    ? "This vault currently has no installed views; use read_document with known paths."
    : `Installed view commands: ${installedViews.map((view) => view.command).join(", ")}. Pass one of these exact commands to run_view with its command-specific input.`;
  const system = [
    AGENT_CHARTER,
    viewCharter,
    ...(hasActionTools ? [ACTION_CHARTER] : []),
    ...(capabilities.has("author") ? [WRITE_CHARTER] : []),
  ].join(" ");
  return {
    model: opts.model ?? anthropic(modelId),
    system,
    messages: [
      ...(opts.history ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      }) satisfies ModelMessage),
      { role: "user", content: opts.question } satisfies ModelMessage,
    ],
    tools: buildAgentTools(opts.vault, citations, action),
    maxSteps: opts.maxSteps ?? 8,
    citations,
    changes,
    abortSignal: opts.abortSignal,
  };
}

/**
 * Map the AI SDK's unified finishReason onto our coarse stopReason. "stop"
 * means the model ended naturally; anything else (e.g. "tool-calls" when the
 * step cap fired mid-loop, or "length") means we were cut off.
 */
function stopReasonOf(finishReason: FinishReason): "final" | "budget" {
  return finishReason === "stop" ? "final" : "budget";
}

/**
 * The streaming counterpart of an ask run. The server iterates `fullStream` to
 * forward text deltas to the client as they arrive; `citations` is the SAME
 * array the tools push into during the run (complete once the stream drains);
 * `finished` resolves after the stream fully drains with the coarse stopReason.
 */
export type AgentStream = {
  /** The AI SDK fullStream: text-delta / tool-call / tool-result / finish / error parts. */
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  /** Populated as the tools run; complete once `finished` resolves. */
  readonly citations: Citation[];
  /** Vault writes made this run; same array the tools push into — complete once `finished` resolves. */
  readonly changes: AgentChange[];
  /** Resolves after the stream drains with the run's coarse stopReason. */
  readonly finished: Promise<{
    readonly stopReason: "final" | "budget";
    readonly steps?: number | undefined;
  }>;
};

/**
 * Drive the built-in agent loop via streamText so a client gets token-by-token
 * output. The returned value is both
 * iterable (fullStream) and readable-after (citations once finished resolves).
 */
export function runAgentStream(opts: AgentOptions): AgentStream {
  const { model, system, messages, tools, maxSteps, citations, changes, abortSignal } =
    setupAgent(opts);

  const result = streamText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });

  return {
    fullStream: result.fullStream,
    citations,
    changes,
    // Never rejects: on abort-before-first-step the AI SDK may reject
    // result.finishReason, which would leave a dangling unhandledRejection if
    // the route's for-await throws before reaching `await stream.finished`.
    // Catch here and fall back to "budget" so the promise is always settled.
    finished: Promise.all([result.finishReason, result.steps]).then(
      ([finishReason, steps]) => ({
        stopReason: stopReasonOf(finishReason),
        steps: steps.length,
      }),
      () => ({ stopReason: "budget" as const, steps: 0 }),
    ),
  };
}

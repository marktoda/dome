// src/assistant/tools.ts
//
// Vault tools for the agent backend, expressed as a Vercel AI SDK
// tool set (Record<string, Tool>). The AI SDK runs each tool's `execute` during
// generateText(), so citations are accumulated into a shared array provided by
// runAgent and read back after the run completes.
//
// Wraps the Vault handle's three recall entry-points:
//   vault.runView("query", {text, limit})  — FTS + ranked matches
//   vault.readDocument(path)               — full document content
//   vault.runView("today", {date?})        — daily action surface
//
// Beyond recall, the assistant speaks the same contract operations as the
// HTTP routes and MCP tools — thin wrappers over the shared src/surface/
// collectors, gated by the same capability vocabulary ROUTE_CAPABILITY uses
// (src/http/server.ts):
//
//   capture_note     capture  → performCapture     (dome.capture/v1)
//   settle_task      resolve  → performSettle      (dome.settle/v1)
//   resolve_question resolve  → vault.resolve      (dome.answer/v1)
//   list_proposals   read     → collectProposals   (dome.proposals/v1)
//   apply_proposal   resolve  → performApply       (dome.apply/v1)
//   reject_proposal  resolve  → performReject      (dome.reject/v1)
//   create_document  author   → createDocument     (agent write path)
//   edit_document    author   → editDocument       (agent write path)
//
// Each tool returns the collector's JSON document as a string; mutating
// tools additionally push one AgentChange into the shared `changes` array
// (the PWA change display + agent-log contract).
//
// Real view-result shape (VaultViewResult kind "ok"):
//   { kind: "ok", views, structured: { name, schema, data } | null, brokerDiagnostics }
//
// Real dome.search.query/v1 structured.data shape:
//   { matches: [{ path, title, snippet, sourceRefs: [{ path, commit }], ... }] }
//   Note: sourceRefs is a PLURAL ARRAY — not a singular sourceRef object.
//
// dome.daily.today/v1 is validated against the shared todayPayloadSchema
// (src/surface/today-view.ts) — the contract pins openTasks/followups/questions
// and the plural sourceRefs array, so this consumer no longer re-derives the
// shape by hand (that drift is what the contract retired).

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Vault } from "../vault";
import type { Citation, AgentChange } from "./types";
import { todayPayloadSchema } from "../surface/today-view";
import { createDocument, editDocument } from "./write";
import { has, type Capability } from "../capabilities";
import { captureJsonDocument, performCapture } from "../surface/capture";
import { performSettle, settleResultJson } from "../surface/settle";
import {
  applyResultJson,
  collectProposals,
  performApply,
  performReject,
  proposalsJson,
  rejectResultJson,
} from "../surface/proposals";
import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../surface/answer";

// ----- helpers ----------------------------------------------------------------

function recordCitation(citations: Citation[], c: Citation): void {
  if (!citations.some((x) => x.path === c.path)) citations.push(c);
}

/**
 * Extract a citation from a single query match item.
 * sourceRefs is a plural array; use the first entry.
 */
function citationFromMatch(m: Record<string, unknown>): Citation | null {
  // sourceRefs is an array: [{path, commit, ...}]
  const sourceRefs = m["sourceRefs"];
  const firstRef =
    Array.isArray(sourceRefs) && sourceRefs.length > 0
      ? (sourceRefs[0] as Record<string, unknown>)
      : undefined;

  // Fall back to the match's own path field if sourceRefs is absent
  const path =
    typeof firstRef?.["path"] === "string"
      ? firstRef["path"]
      : typeof m["path"] === "string"
        ? (m["path"] as string)
        : null;

  if (path === null) return null;

  return {
    path,
    commit:
      typeof firstRef?.["commit"] === "string" ? firstRef["commit"] : undefined,
    snippet:
      typeof m["snippet"] === "string" ? (m["snippet"] as string) : undefined,
  };
}

/**
 * Run the "query" view and render results from structured.data.matches.
 */
async function runQueryView(
  vault: Vault,
  args: Record<string, unknown>,
  citations: Citation[],
): Promise<string> {
  const result = (await vault.runView("query", args)) as {
    kind: string;
    structured?: {
      data?: { matches?: ReadonlyArray<Record<string, unknown>> };
    } | null;
  };

  if (result.kind !== "ok") {
    return `error: query view unavailable (${result.kind}).`;
  }

  const matches = result.structured?.data?.["matches"];
  if (!Array.isArray(matches) || matches.length === 0) {
    return "no results.";
  }

  const lines: string[] = [];
  for (const m of matches as ReadonlyArray<Record<string, unknown>>) {
    const cite = citationFromMatch(m);
    if (cite !== null) recordCitation(citations, cite);
    const title = typeof m["title"] === "string" ? m["title"] : "(untitled)";
    const path =
      cite?.path ??
      (typeof m["path"] === "string" ? (m["path"] as string) : "(no path)");
    const snippet = typeof m["snippet"] === "string" ? m["snippet"] : "";
    lines.push(`- ${title} [${path}]${snippet ? `: ${snippet}` : ""}`);
  }
  return lines.join("\n");
}

// A loose render view of any today row (task or question). The `| undefined`
// on each optional matches the validated contract rows under
// exactOptionalPropertyTypes.
type TodayItem = {
  readonly text?: string | undefined;
  readonly path?: string | undefined;
  readonly sourceRefs?:
    | ReadonlyArray<{ readonly path: string; readonly commit?: string | undefined }>
    | undefined;
};

/**
 * Run the "today" view and produce a readable summary from the real
 * dome.daily.today/v1 structured data shape (openTasks, followups, questions).
 */
async function runTodayView(
  vault: Vault,
  args: Record<string, unknown>,
  citations: Citation[],
): Promise<string> {
  const result = (await vault.runView("today", args)) as {
    kind: string;
    structured?: { data?: unknown } | null;
  };

  if (result.kind !== "ok") {
    return `error: today view unavailable (${result.kind}).`;
  }

  const parsed = todayPayloadSchema.safeParse(result.structured?.data);
  if (!parsed.success) {
    return "no daily data available.";
  }
  const data = parsed.data;

  const sections: string[] = [];
  if (typeof data.date === "string") {
    sections.push(`# Today — ${data.date}`);
  }

  function renderSection(
    heading: string,
    items: ReadonlyArray<TodayItem> | undefined,
  ): void {
    if (!Array.isArray(items) || items.length === 0) return;
    sections.push(`\n## ${heading}`);
    for (const item of items) {
      // Record a citation for each item that has a sourceRef.
      const ref = Array.isArray(item.sourceRefs) ? item.sourceRefs[0] : undefined;
      const sourcePath =
        typeof ref?.path === "string"
          ? ref.path
          : typeof item.path === "string"
            ? item.path
            : null;
      if (sourcePath !== null) {
        recordCitation(citations, {
          path: sourcePath,
          commit: typeof ref?.commit === "string" ? ref.commit : undefined,
        });
      }
      const itemLabel =
        typeof item.text === "string" ? item.text : sourcePath ?? "(item)";
      sections.push(`- ${itemLabel}${sourcePath ? ` [${sourcePath}]` : ""}`);
    }
  }

  renderSection("Open tasks", data.openTasks);
  renderSection("Follow-ups", data.followups);
  renderSection("Questions", data.questions);

  if (sections.length === 0) return "no open items for today.";
  return sections.join("\n");
}

// ----- public API -------------------------------------------------------------

/**
 * Action context for the contract + write tools. `capabilities` is the same
 * granted set the HTTP routes gate on (the server passes it through
 * runAgent/runAgentStream): `capture` provisions capture_note, `resolve`
 * provisions settle_task/resolve_question/apply_proposal/reject_proposal,
 * `read` provisions list_proposals, and `author` provisions
 * create_document/edit_document. Mutating tools push each successful
 * operation into `changes`. When no context is given, only the three read
 * tools are provisioned.
 */
export type AgentActionContext = {
  readonly vaultPath: string;
  readonly modelId: string;
  readonly changes: AgentChange[];
  readonly capabilities: ReadonlySet<Capability>;
};

/**
 * Build the AI SDK tool set for the ask agent. Citations gathered during tool
 * execution are pushed into the shared `citations` array (read back by runAgent
 * after generateText resolves).
 */
export function buildAgentTools(
  vault: Vault,
  citations: Citation[],
  action?: AgentActionContext | undefined,
): ToolSet {
  const tools: ToolSet = {
    search_vault: tool({
      description:
        "Full-text + fact search over the adopted vault. Returns ranked matches with their source paths. Use this first to find relevant pages.",
      inputSchema: z.object({
        text: z.string().describe("The search query."),
        limit: z
          .number()
          .optional()
          .describe("Max matches (default 8)."),
      }),
      execute: async (input) => {
        const text = typeof input.text === "string" ? input.text : "";
        if (text.trim().length === 0) {
          return "error: search_vault requires non-empty `text`.";
        }
        const limit = typeof input.limit === "number" ? input.limit : 8;
        return runQueryView(vault, { text, limit }, citations);
      },
    }),
    read_document: tool({
      description:
        "Read the full markdown of a vault page by path (as returned by search_vault). Use to get detail before answering.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative path, e.g. wiki/entities/x.md."),
      }),
      execute: async (input) => {
        const path = typeof input.path === "string" ? input.path : "";
        if (path.trim().length === 0) {
          return "error: read_document requires `path`.";
        }
        const doc = await vault.readDocument(path);
        if (doc === null) {
          return `not found: no adopted document at '${path}'.`;
        }
        recordCitation(citations, { path: doc.path, commit: doc.commit });
        return doc.content;
      },
    }),
    todays_brief: tool({
      description:
        "The owner's brief for today: open tasks, follow-ups, and questions. Use when the question is about 'today', 'now', or what's open.",
      inputSchema: z.object({
        date: z
          .string()
          .optional()
          .describe("ISO date; defaults to today."),
      }),
      execute: async (input) => {
        const date = typeof input.date === "string" ? input.date : undefined;
        return runTodayView(
          vault,
          date !== undefined ? { date } : {},
          citations,
        );
      },
    }),
  };

  if (action === undefined) return tools;

  // Serialize a collector's JSON document as the tool result, recording a
  // change entry when the operation actually landed. Mirrors the MCP tools:
  // the doc itself carries the status; failures come back as documents, not
  // throws (a failed operation must not crash the agent loop).
  const jsonResult = (
    doc: Record<string, unknown>,
    change?: AgentChange | undefined,
  ): string => {
    if (change !== undefined) action.changes.push(change);
    return JSON.stringify(doc, null, 2);
  };

  if (has(action.capabilities, "capture")) {
    tools["capture_note"] = tool({
      description:
        "Capture a thought into the vault inbox: writes inbox/raw/<stamp>-<slug>.md and commits exactly that one file. Use when the owner wants to save a note, idea, or reminder. Returns the dome.capture/v1 JSON document with the created path.",
      inputSchema: z.object({
        text: z.string().describe("Capture body (markdown or plain text)."),
        title: z
          .string()
          .optional()
          .describe("Optional explicit title; drives the filename slug and commit message."),
      }),
      execute: async (input) => {
        const outcome = await performCapture({
          text: input.text,
          ...(input.title !== undefined ? { title: input.title } : {}),
          vault: action.vaultPath,
          source: "assistant",
        });
        return jsonResult(
          captureJsonDocument(outcome),
          outcome.kind === "captured"
            ? { path: outcome.result.path, kind: "capture" }
            : undefined,
        );
      },
    });
  }

  if (has(action.capabilities, "resolve")) {
    tools["settle_task"] = tool({
      description:
        "Settle a task line located by its ^block-anchor id (as shown by todays_brief): close checks the box and records a Done-today bullet, defer rewrites the due date to deferUntil, keep settles without writing. Never invent an anchor — read it from todays_brief first. Returns the dome.settle/v1 JSON document.",
      inputSchema: z.object({
        blockId: z.string().describe("The task line's ^block-anchor id (without the caret)."),
        disposition: z.enum(["close", "defer", "keep"]).describe("close | defer | keep."),
        deferUntil: z
          .string()
          .optional()
          .describe("YYYY-MM-DD; required iff disposition is defer."),
      }),
      execute: async (input) => {
        const outcome = await performSettle(action.vaultPath, {
          blockId: input.blockId,
          disposition: input.disposition,
          ...(input.deferUntil !== undefined ? { deferUntil: input.deferUntil } : {}),
        });
        return jsonResult(
          settleResultJson(outcome),
          outcome.status === "settled" && outcome.commit !== undefined
            ? { path: `^${input.blockId}`, kind: "settle" }
            : undefined,
        );
      },
    });

    tools["resolve_question"] = tool({
      description:
        "Answer a Dome-raised question by its numeric id (ids come from todays_brief). Never invent an id — look it up first. Returns the dome.answer/v1 JSON document.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Question id."),
        value: z.string().describe("The decision value (one of the question's options, when listed)."),
      }),
      execute: async (input) => {
        const value = input.value.trim();
        if (value.length === 0) {
          return jsonResult({
            schema: ANSWER_SCHEMA,
            status: "error",
            error: "resolve-usage",
            message: "resolve_question requires a non-empty `value`.",
          });
        }
        const outcome = await vault.resolve(input.id, value);
        switch (outcome.kind) {
          case "not-found":
            return jsonResult({
              schema: ANSWER_SCHEMA,
              status: "error",
              error: "question-not-found",
              message: `question ${input.id} was not found.`,
            });
          case "invalid-option":
            return jsonResult({
              schema: ANSWER_SCHEMA,
              status: "invalid-option",
              options: outcome.options,
              question: questionRecordJson(outcome.record),
            });
          case "answered":
          case "already-answered":
            return jsonResult(
              {
                schema: ANSWER_SCHEMA,
                status: outcome.kind,
                question: questionRecordJson(outcome.record),
                handlers:
                  outcome.handlers === null
                    ? null
                    : answerHandlersJson(outcome.handlers),
              },
              outcome.kind === "answered"
                ? { path: `question:${input.id}`, kind: "resolve" }
                : undefined,
            );
        }
      },
    });

    tools["apply_proposal"] = tool({
      description:
        "Apply a pending garden-proposed edit by id (ids come from list_proposals) as one ordinary commit. Fails if the proposal is not pending or has gone stale. Returns the dome.apply/v1 JSON document.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Proposal id from list_proposals."),
      }),
      execute: async (input) => {
        const outcome = await performApply(action.vaultPath, input.id);
        return jsonResult(
          applyResultJson(outcome),
          outcome.status === "applied"
            ? { path: `proposal:${input.id}`, kind: "apply" }
            : undefined,
        );
      },
    });

    tools["reject_proposal"] = tool({
      description:
        "Reject a pending garden-proposed edit by id (ids come from list_proposals); touches no files. Optional note records why. Returns the dome.reject/v1 JSON document.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Proposal id from list_proposals."),
        note: z.string().optional().describe("Optional note recording why."),
      }),
      execute: async (input) => {
        const outcome = await performReject(action.vaultPath, input.id, input.note);
        return jsonResult(
          rejectResultJson(outcome),
          outcome.status === "rejected"
            ? { path: `proposal:${input.id}`, kind: "reject" }
            : undefined,
        );
      },
    });
  }

  if (has(action.capabilities, "read")) {
    tools["list_proposals"] = tool({
      description:
        "List garden-proposed edits awaiting owner review (pending by default; set all for decided rows too). Use before apply_proposal / reject_proposal to get real ids. Returns the dome.proposals/v1 JSON document.",
      inputSchema: z.object({
        all: z
          .boolean()
          .optional()
          .describe("Include applied/rejected rows too (default: pending only)."),
      }),
      execute: async (input) =>
        jsonResult(
          proposalsJson(
            await collectProposals(
              action.vaultPath,
              input.all !== undefined ? { all: input.all } : {},
            ),
          ),
        ),
    });
  }

  if (has(action.capabilities, "author")) {
    // Run a write op, record the change, and surface failures to the model as
    // an `error: …` string (never throw — a rejected write must not crash the loop).
    const runWrite = async (
      op: () => Promise<AgentChange>,
      verb: "created" | "edited",
    ): Promise<string> => {
      try {
        const change = await op();
        action.changes.push(change);
        return `${verb} ${change.path}`;
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    tools["create_document"] = tool({
      description:
        "Create a NEW markdown page in the vault and commit it. Fails if the path already exists — use edit_document for an existing page. Path is vault-relative (e.g. wiki/notes/foo.md), .md only; .dome/ is off-limits.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path for the new page."),
        content: z.string().describe("Full markdown content of the new page."),
      }),
      execute: (input) =>
        runWrite(() => createDocument(action, { path: input.path, content: input.content }), "created"),
    });
    tools["edit_document"] = tool({
      description:
        "Edit an existing vault page by replacing an exact, UNIQUE substring, then commit. old_string must appear exactly once — include enough surrounding context to be unique. Use to check off a task ('- [ ]' → '- [x]'), fix a line, etc.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path of the page to edit."),
        old_string: z.string().describe("Exact text to replace; must be unique in the file."),
        new_string: z.string().describe("Replacement text."),
      }),
      execute: (input) =>
        runWrite(
          () =>
            editDocument(action, {
              path: input.path,
              old_string: input.old_string,
              new_string: input.new_string,
            }),
          "edited",
        ),
    });
  }

  return tools;
}

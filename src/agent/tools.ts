// src/agent/tools.ts
//
// Read-only vault tools for the ask-agent backend, expressed as a Vercel AI SDK
// tool set (Record<string, Tool>). The AI SDK runs each tool's `execute` during
// generateText(), so citations are accumulated into a shared array provided by
// runAgent and read back after the run completes.
//
// Wraps the Vault handle's three recall entry-points:
//   vault.runView("query", {text, limit})  — FTS + ranked matches
//   vault.readDocument(path)               — full document content
//   vault.runView("today", {date?})        — daily action surface
//
// Real view-result shape (VaultViewResult kind "ok"):
//   { kind: "ok", views, structured: { name, schema, data } | null, brokerDiagnostics }
//
// Real dome.search.query/v1 structured.data shape:
//   { matches: [{ path, title, snippet, sourceRefs: [{ path, commit }], ... }] }
//   Note: sourceRefs is a PLURAL ARRAY — not a singular sourceRef object.
//
// Real dome.daily.today/v1 structured.data shape:
//   { date, openTasks: [...], followups: [...], questions: [...], ... }
//   Each item has sourceRefs: [{ path, commit }]. No top-level "matches" key.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Vault } from "../vault";
import type { Citation } from "./types";
import type { AgentChange } from "./types";
import { createDocument, editDocument } from "./write";

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

type TodayItem = {
  readonly text?: string;
  readonly path?: string;
  readonly sourceRefs?: ReadonlyArray<{ path: string; commit?: string }>;
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
    structured?: {
      data?: {
        date?: string;
        openTasks?: ReadonlyArray<TodayItem>;
        followups?: ReadonlyArray<TodayItem>;
        questions?: ReadonlyArray<TodayItem>;
      };
    } | null;
  };

  if (result.kind !== "ok") {
    return `error: today view unavailable (${result.kind}).`;
  }

  const data = result.structured?.data;
  if (data === undefined || data === null) {
    return "no daily data available.";
  }

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
 * Author context for the write tools. When passed to buildAgentTools, the
 * create_document / edit_document tools are provisioned (this presence IS the
 * `author` gate); the tools push each successful write into `changes`.
 */
export type AgentWriteContext = {
  readonly vaultPath: string;
  readonly modelId: string;
  readonly changes: AgentChange[];
};

/**
 * Build the AI SDK tool set for the ask agent. Citations gathered during tool
 * execution are pushed into the shared `citations` array (read back by runAgent
 * after generateText resolves).
 */
export function buildAgentTools(
  vault: Vault,
  citations: Citation[],
  write?: AgentWriteContext | undefined,
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

  if (write !== undefined) {
    tools["create_document"] = tool({
      description:
        "Create a NEW markdown page in the vault and commit it. Fails if the path already exists — use edit_document for an existing page. Path is vault-relative (e.g. wiki/notes/foo.md), .md only; .dome/ is off-limits.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path for the new page."),
        content: z.string().describe("Full markdown content of the new page."),
      }),
      execute: async (input) => {
        try {
          const change = await createDocument(
            { vaultPath: write.vaultPath, modelId: write.modelId },
            { path: String(input.path), content: String(input.content) },
          );
          write.changes.push(change);
          return `created ${change.path}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
    tools["edit_document"] = tool({
      description:
        "Edit an existing vault page by replacing an exact, UNIQUE substring, then commit. old_string must appear exactly once — include enough surrounding context to be unique. Use to check off a task ('- [ ]' → '- [x]'), fix a line, etc.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path of the page to edit."),
        old_string: z.string().describe("Exact text to replace; must be unique in the file."),
        new_string: z.string().describe("Replacement text."),
      }),
      execute: async (input) => {
        try {
          const change = await editDocument(
            { vaultPath: write.vaultPath, modelId: write.modelId },
            {
              path: String(input.path),
              old_string: String(input.old_string),
              new_string: String(input.new_string),
            },
          );
          write.changes.push(change);
          return `edited ${change.path}`;
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    });
  }

  return tools;
}

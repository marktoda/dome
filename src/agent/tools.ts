// src/agent/tools.ts
//
// Read-only vault tools for the ask-agent backend.
//
// Wraps the Vault handle's two recall entry-points:
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
//   Each item has sourceRefs: [{ path, commit }].
//   No top-level "matches" key — adapted via todaysSummary().

import type { Vault } from "../vault";
import type { AskTool, AskState, AskCitation } from "./types";

// ----- helpers ----------------------------------------------------------------

function recordCitation(state: AskState, c: AskCitation): void {
  if (!state.citations.some((x) => x.path === c.path)) state.citations.push(c);
}

/**
 * Extract a citation from a single query match item.
 * sourceRefs is a plural array; use the first entry.
 */
function citationFromMatch(
  m: Record<string, unknown>,
): AskCitation | null {
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
  state: AskState,
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
    if (cite !== null) recordCitation(state, cite);
    const title =
      typeof m["title"] === "string" ? m["title"] : "(untitled)";
    const path = cite?.path ?? typeof m["path"] === "string" ? (m["path"] as string) : "(no path)";
    const snippet =
      typeof m["snippet"] === "string" ? m["snippet"] : "";
    lines.push(`- ${title} [${path}]${snippet ? `: ${snippet}` : ""}`);
  }
  return lines.join("\n");
}

type TodayItem = {
  readonly title?: string;
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
  state: AskState,
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
        recordCitation(state, {
          path: sourcePath,
          commit: typeof ref?.commit === "string" ? ref.commit : undefined,
        });
      }
      const itemLabel =
        typeof item.title === "string"
          ? item.title
          : typeof item.text === "string"
            ? item.text
            : sourcePath ?? "(item)";
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

export function buildAskTools(vault: Vault): ReadonlyArray<AskTool> {
  return [
    {
      schema: {
        name: "search_vault",
        description:
          "Full-text + fact search over the adopted vault. Returns ranked matches with their source paths. Use this first to find relevant pages.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "The search query." },
            limit: {
              type: "number",
              description: "Max matches (default 8).",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
      execute: async (input, state) => {
        const raw = input as Record<string, unknown>;
        const text = typeof raw?.["text"] === "string" ? String(raw["text"]) : "";
        if (text.trim().length === 0) {
          return "error: search_vault requires non-empty `text`.";
        }
        const limit =
          typeof raw?.["limit"] === "number" ? Number(raw["limit"]) : 8;
        return runQueryView(vault, { text, limit }, state);
      },
    },
    {
      schema: {
        name: "read_document",
        description:
          "Read the full markdown of a vault page by path (as returned by search_vault). Use to get detail before answering.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Vault-relative path, e.g. wiki/entities/x.md.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      execute: async (input, state) => {
        const raw = input as Record<string, unknown>;
        const path = typeof raw?.["path"] === "string" ? String(raw["path"]) : "";
        if (path.trim().length === 0) {
          return "error: read_document requires `path`.";
        }
        const doc = await vault.readDocument(path);
        if (doc === null) {
          return `not found: no adopted document at '${path}'.`;
        }
        recordCitation(state, { path: doc.path, commit: doc.commit });
        return doc.content;
      },
    },
    {
      schema: {
        name: "todays_brief",
        description:
          "The owner's brief for today: open tasks, follow-ups, and questions. Use when the question is about 'today', 'now', or what's open.",
        inputSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "ISO date; defaults to today.",
            },
          },
          additionalProperties: false,
        },
      },
      execute: async (input, state) => {
        const raw = input as Record<string, unknown>;
        const date =
          typeof raw?.["date"] === "string" ? String(raw["date"]) : undefined;
        return runTodayView(
          vault,
          date !== undefined ? { date } : {},
          state,
        );
      },
    },
  ];
}

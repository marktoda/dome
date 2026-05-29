// cli/commands/query: first-class adopted-state query command.
//
// `dome query` is a small typed wrapper around the command-triggered
// view-phase processor named `query`. The processor owns retrieval behavior;
// this file owns CLI ergonomics and rendering.

import {
  printViewCommandMessages,
  runStructuredViewCommand,
  structuredViewBrokerMessages,
} from "./view-shared";
import { formatJson } from "../format";

export type QueryCommandOptions = {
  readonly text?: string | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly category?: string | undefined;
  readonly type?: string | undefined;
};

export async function runQuery(
  options: QueryCommandOptions = {},
): Promise<number> {
  const text = options.text?.trim() ?? "";
  if (text.length === 0) {
    console.error("dome query: missing query text. Usage: dome query <text>");
    return 64;
  }

  try {
    const run = await runStructuredViewCommand({
      commandLabel: "dome query",
      commandName: "query",
      expectedViewName: "dome.search.query",
      expectedSchema: "dome.search.query/v1",
      commandArgs: Object.freeze({
        text,
        ...(options.category !== undefined ? { category: options.category } : {}),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      vault: options.vault,
      bundlesRoot: options.bundlesRoot,
      notFoundMessage:
        "dome query: dome.search is not installed or no query processor is enabled. " +
        "For older vault configs, run `dome init --refresh-config` to add current first-party defaults.",
      noStructuredResultMessage:
        "dome query: query processor returned no structured result.",
    });

    if (run.kind === "error") {
      printViewCommandMessages(run.messages);
      return run.exitCode;
    }
    printViewCommandMessages(
      structuredViewBrokerMessages("dome query", run.brokerDiagnostics),
    );

    if (options.json === true) {
      console.log(formatJson(run.data));
    } else {
      console.log(formatQueryResult(run.data));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome query: failed: ${msg}`);
    return 1;
  }
}

function formatQueryResult(data: unknown): string {
  const result = parseQueryResult(data);
  if (result.matches.length === 0) {
    return `No adopted-state matches for "${result.query}".`;
  }

  const lines = [`${result.matches.length} adopted-state match(es) for "${result.query}"`];
  for (const [index, match] of result.matches.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${match.title} (${match.path})`);
    if (match.snippet.length > 0) {
      lines.push(`   ${stripFtsMarkers(match.snippet)}`);
    }
    if (match.sourceRefs.length > 0) {
      lines.push("   SourceRefs:");
      for (const ref of match.sourceRefs) {
        lines.push(`     - ${formatSourceRef(ref)}`);
      }
    }
    if (match.facts.length > 0) {
      const facts = match.facts
        .slice(0, 5)
        .map((fact) => fact.predicate)
        .join(", ");
      lines.push(`   facts: ${facts}`);
    }
  }
  return lines.join("\n");
}

type QueryResultData = {
  readonly query: string;
  readonly matches: ReadonlyArray<{
    readonly path: string;
    readonly title: string;
    readonly snippet: string;
    readonly sourceRefs: ReadonlyArray<QuerySourceRef>;
    readonly facts: ReadonlyArray<{ readonly predicate: string }>;
  }>;
};

type QuerySourceRef = {
  readonly path: string;
  readonly commit: string;
  readonly range?: {
    readonly startLine: number;
    readonly endLine: number;
  };
};

function parseQueryResult(data: unknown): QueryResultData {
  const record = data !== null && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  const query = typeof record.query === "string" ? record.query : "";
  const rawMatches = Array.isArray(record.matches) ? record.matches : [];
  return Object.freeze({
    query,
    matches: Object.freeze(
      rawMatches.map((raw) => {
        const match = raw !== null && typeof raw === "object"
          ? raw as Record<string, unknown>
          : {};
        return Object.freeze({
          path: stringOrEmpty(match.path),
          title: stringOrEmpty(match.title),
          snippet: stringOrEmpty(match.snippet),
          sourceRefs: Object.freeze(parseSourceRefs(match.sourceRefs)),
          facts: Object.freeze(parseFacts(match.facts)),
        });
      }),
    ),
  });
}

function parseFacts(raw: unknown): ReadonlyArray<{ readonly predicate: string }> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const predicate = stringOrEmpty(record.predicate);
        return predicate.length > 0 ? { predicate } : null;
      })
      .filter((item): item is { readonly predicate: string } => item !== null),
  );
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSourceRefs(raw: unknown): ReadonlyArray<QuerySourceRef> {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw
      .map((item) => {
        const record = item !== null && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        const path = stringOrEmpty(record.path);
        const commit = stringOrEmpty(record.commit);
        if (path.length === 0 || commit.length === 0) return null;

        const range = parseRange(record.range);
        return Object.freeze({
          path,
          commit,
          ...(range !== null ? { range } : {}),
        });
      })
      .filter((item): item is QuerySourceRef => item !== null),
  );
}

function parseRange(raw: unknown): QuerySourceRef["range"] | null {
  const record = raw !== null && typeof raw === "object"
    ? raw as Record<string, unknown>
    : {};
  const startLine = numberValue(record.startLine);
  const endLine = numberValue(record.endLine);
  return startLine === null || endLine === null
    ? null
    : Object.freeze({ startLine, endLine });
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
}

function formatSourceRef(ref: QuerySourceRef): string {
  const range = ref.range === undefined
    ? ""
    : `:${ref.range.startLine}-${ref.range.endLine}`;
  return `${ref.path}${range} @ ${ref.commit.slice(0, 7)}`;
}

function stripFtsMarkers(snippet: string): string {
  return snippet.replace(/\[/g, "").replace(/\]/g, "");
}

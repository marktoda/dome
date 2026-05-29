// cli/commands/query: first-class adopted-state query command.
//
// `dome query` is a small typed wrapper around the command-triggered
// view-phase processor named `query`. The processor owns retrieval behavior;
// this file owns CLI ergonomics and rendering.

import { resolve } from "node:path";

import { getAdoptedRef, getCurrentBranch } from "../../adopted-ref";
import { commitOid } from "../../core/source-ref";
import { runViewCommand } from "../../engine/commands";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { buildSqliteSinks } from "../../projections/sinks";

import { resolveShippedBundlesRoot } from "./sync-shared";
import { formatJson } from "../format";

import type { ApplyEffectSinks } from "../../engine/apply-effect";
import type { ViewEffect } from "../../core/effect";

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

  const vaultPath = resolve(options.vault ?? process.cwd());
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();

  const branch = await getCurrentBranch(vaultPath);
  if (branch === null) {
    console.error(
      "dome query: HEAD is detached. Check out a branch and retry.",
    );
    return 64;
  }
  const adoptedSha = await getAdoptedRef(vaultPath, branch);
  if (adoptedSha === null) {
    console.error(
      `dome query: vault has no adopted ref for branch '${branch}'. Run \`dome sync\` first to initialize.`,
    );
    return 64;
  }
  const adopted = commitOid(adoptedSha);

  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome query: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const capturedViews: ViewEffect[] = [];
    const captureView: ApplyEffectSinks["captureView"] = async ({ effect }) => {
      capturedViews.push(effect);
    };
    const applyPatch: ApplyEffectSinks["applyPatch"] = async () => null;
    const recoverQuarantine: ApplyEffectSinks["recoverQuarantine"] =
      async () => undefined;
    const sinks = buildSqliteSinks({
      projectionDb: runtime.projectionDb,
      outboxDb: runtime.outboxDb,
      adoptedCommit: adopted,
      captureView,
      applyPatch,
      externalHandlers: runtime.externalHandlers,
      recoverQuarantine,
    });

    const result = await runViewCommand({
      vault: {
        path: vaultPath,
        config: { git: { auto_commit_workflows: false } },
      },
      adopted,
      commandName: "query",
      commandArgs: Object.freeze({
        text,
        ...(options.category !== undefined ? { category: options.category } : {}),
        ...(options.type !== undefined ? { type: options.type } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      }),
      viewRunner: runtime.processorRuntime.viewRunner,
      sinks,
      ledger: runtime.ledgerDb,
    });

    if (result.kind === "not-found") {
      console.error(
        "dome query: dome.search is not installed or no query processor is enabled.",
      );
      return 64;
    }

    for (const d of result.brokerDiagnostics) {
      console.error(
        `dome query: broker diagnostic [${d.severity}] ${d.code}: ${d.message}`,
      );
    }

    const view = capturedViews[0] ?? result.effects[0];
    if (view === undefined || view.content.kind !== "structured") {
      console.error("dome query: query processor returned no structured result.");
      return 1;
    }

    if (options.json === true) {
      console.log(formatJson(view.content.data));
    } else {
      console.log(formatQueryResult(view.content.data));
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`dome query: failed: ${msg}`);
    return 1;
  } finally {
    await runtime.close();
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
    readonly facts: ReadonlyArray<{ readonly predicate: string }>;
  }>;
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

function stripFtsMarkers(snippet: string): string {
  return snippet.replace(/\[/g, "").replace(/\]/g, "");
}

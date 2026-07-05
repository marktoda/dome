// surface/report-miss: the retrieval-miss log — the evidence base the memory
// plan gated retrieval-quality work (banked embeddings) on
// (docs/wiki/matrices/... memory plan) but never operationalized: agents were
// asked to "note the miss" with no mechanical channel. This is that channel.
//
// Mirrors `performCapture` (src/surface/capture.ts) and `performSettle`
// (src/surface/settle.ts): `reportMiss` appends one dated bullet to
// `meta/retrieval-misses.md` (created with a header on first miss) and lands
// it as ONE ordinary HUMAN commit (`miss: <query first 40 chars>`, no
// `Dome-*` trailers) via `commitSingleFileOnHead` — never talks to the
// engine; the daemon constructs the Proposal from the resulting branch drift
// (PROPOSALS_ARE_THE_ONLY_WRITE_PATH).
//
// The entry grammar is load-bearing: Task 11's weekly report card
// (`assets/extensions/dome.health/processors/report-card-render.ts`)
// counts entries by matching `MISS_ENTRY_PATTERN` against this file's
// content, so both the grammar and the path constant are exported from HERE
// — the collector — and the report-card renderer imports them rather than
// re-deriving its own copy.
//
// Mutation-boundary note: like capture.ts/settle.ts, this is the human-side
// write path at the compiler boundary, not an engine write path. Whitelisted
// in `tests/integration/no-direct-mutation-outside-boundaries.test.ts`.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatDate,
  localDateParts,
} from "../../assets/extensions/dome.daily/processors/daily-paths";
import { commitSingleFileOnHead, currentBranch, currentSha, findGitRoot } from "../git";
import { resolveVaultPath } from "./resolve-vault";

// ----- Grammar (exported so nothing re-derives it) ---------------------------

/** The retrieval-miss log path — a `meta/` convention beside `preferences/signals.md`. */
export const RETRIEVAL_MISSES_PATH = "meta/retrieval-misses.md";

/**
 * Matches one grammar-exact miss entry line, capturing the `YYYY-MM-DD` date.
 * Grammar: `- YYYY-MM-DD — "<query>" — <note>` (em-dash separators). Task
 * 11's report card counts window-matched entries with this exact pattern
 * (`assets/extensions/dome.health/processors/report-card-render.ts`
 * `countRetrievalMisses`) — it imports this constant rather than hardcoding
 * its own copy.
 */
export const MISS_ENTRY_PATTERN = /^- (\d{4}-\d{2}-\d{2}) —/;

const HEADER = [
  "# Retrieval misses",
  "",
  "Append-only dogfood log: every time `dome query` / `dome export-context`",
  "misses obvious context, record it here instead of just telling the user —",
  "this is the evidence base retrieval-quality work (banked embeddings) is",
  "gated on. Written by `dome query --miss`, `dome export-context --miss`,",
  "and the MCP `report_miss` tool; never edited by hand.",
  "",
  "Grammar: `- YYYY-MM-DD — \"<query>\" — <note>`",
  "",
].join("\n");

// ----- Public types ---------------------------------------------------------

export type ReportMissRequest = {
  readonly query: string;
  readonly note?: string | undefined;
};

/** Injectable clock — drives the entry's local date. */
export type ReportMissDeps = {
  readonly now?: (() => Date) | undefined;
};

export type ReportMissResult =
  | { readonly status: "recorded"; readonly commit: string }
  | { readonly status: "invalid"; readonly message: string };

/** Wire schema for the report-miss result document. */
export const REPORT_MISS_SCHEMA = "dome.report-miss/v1";

/** Render a `ReportMissResult` as its `dome.report-miss/v1` document body. */
export function reportMissResultJson(
  result: ReportMissResult,
): Record<string, unknown> {
  if (result.status === "recorded") {
    return {
      schema: REPORT_MISS_SCHEMA,
      status: "recorded",
      commit: result.commit,
    };
  }
  return {
    schema: REPORT_MISS_SCHEMA,
    status: "invalid",
    message: result.message,
  };
}

// ----- Pure helpers (exported for tests) -------------------------------------

/** Render one grammar-exact entry line — the single source of the grammar. */
export function renderMissEntry(input: {
  readonly date: string;
  readonly query: string;
  readonly note: string;
}): string {
  return `- ${input.date} — "${input.query}" — ${input.note}`;
}

/** Collapse whitespace runs (including newlines) to single spaces and trim. */
function oneLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Append `entry` to `existing` content, or start a fresh file with the header. */
function withAppendedEntry(existing: string | null, entry: string): string {
  if (existing === null) return `${HEADER}${entry}\n`;
  const withTrailingNewline = existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${withTrailingNewline}${entry}\n`;
}

function readIfExists(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

// ----- reportMiss ---------------------------------------------------------------

/**
 * Record one retrieval miss: append a grammar-exact entry to
 * `meta/retrieval-misses.md` (created with a header on first miss) and land
 * it as one ordinary human commit. Data-returning and print-free — CLI flags
 * and the MCP `report_miss` tool both render the returned outcome.
 */
export async function reportMiss(
  vault: string,
  req: ReportMissRequest,
  deps: ReportMissDeps = {},
): Promise<ReportMissResult> {
  const query = oneLine(req.query);
  if (query.length === 0) {
    return Object.freeze({
      status: "invalid" as const,
      message: "reportMiss requires a non-empty query",
    });
  }
  const noteRaw = req.note !== undefined ? oneLine(req.note) : "";
  const note = noteRaw.length > 0 ? noteRaw : "no note";

  // --- Vault preconditions (mirror performCapture / performSettle) ----------
  const vaultPath = resolveVaultPath(vault);
  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    return invalid(
      `not an initialized Dome vault (missing ${
        gitRoot === null ? "git repository" : ".dome/config.yaml"
      }); run \`dome init\` first`,
    );
  }
  if ((await currentSha(vaultPath)) === null) {
    return invalid("the vault has no commits yet; run `dome init` first");
  }
  const branch = await currentBranch(vaultPath);
  if (branch === null) {
    return invalid(
      "detached HEAD: recording a miss needs a branch; check out a branch first",
    );
  }

  try {
    const now = (deps.now ?? (() => new Date()))();
    const date = formatDate(localDateParts(now));
    const entry = renderMissEntry({ date, query, note });

    const existing = readIfExists(join(vaultPath, RETRIEVAL_MISSES_PATH));
    const content = withAppendedEntry(existing, entry);

    await mkdir(dirname(join(vaultPath, RETRIEVAL_MISSES_PATH)), { recursive: true });
    await writeFile(join(vaultPath, RETRIEVAL_MISSES_PATH), content, "utf8");

    // Ordinary human commit: `miss: <query first 40 chars>`, no Dome-*
    // trailers. Built against the HEAD tree plus this one blob, exactly like
    // `dome capture`.
    const commit = await commitSingleFileOnHead({
      path: vaultPath,
      filepath: RETRIEVAL_MISSES_PATH,
      content,
      message: `miss: ${query.slice(0, 40)}`,
      author: { name: "dome miss", email: "dome-miss@local" },
    });

    return Object.freeze({ status: "recorded" as const, commit });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(`reportMiss failed: ${msg}`);
  }
}

function invalid(message: string): ReportMissResult {
  return Object.freeze({ status: "invalid" as const, message });
}

// ----- The CLI optional-value-flag seam ---------------------------------------

/**
 * Resolve `--miss [note]`'s Commander shape (`undefined` when absent, `true`
 * for the bare flag, or the supplied string) into a `reportMiss` call.
 * Returns `null` when the flag was not passed — the thin wiring both
 * `dome query --miss` and `dome export-context --miss` share so the
 * optional-value semantics live in one place, not duplicated per command.
 */
export async function reportMissFromCliFlag(input: {
  readonly vault: string;
  readonly query: string;
  readonly flag: string | boolean | undefined;
}): Promise<ReportMissResult | null> {
  if (input.flag === undefined || input.flag === false) return null;
  const note = typeof input.flag === "string" ? input.flag : undefined;
  return reportMiss(input.vault, { query: input.query, note });
}

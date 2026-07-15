// surface/settle: the commit-or-nothing settle seam — the second remote-write
// operation beside `performCapture` (docs/wiki/specs/capture.md §"The
// remote-capture seam"; docs/wiki/specs/task-lifecycle.md §"The settle
// operation").
//
// Settling is a DECISION, not authoring — like `resolve`, not like editing.
// `performSettle` locates a task line by its move-stable `^block-anchor`
// across the vault's markdown and applies a close / defer / keep disposition
// as one ordinary HUMAN commit carrying only the mutation Module's
// `Dome-Request` attribution trailer. The daemon constructs a
// Proposal from the branch drift exactly like a terminal capture
// (PROPOSALS_ARE_THE_ONLY_WRITE_PATH); this seam never calls the engine, never
// writes projections, never opens the runtime.
//
//   - close  → set `- [x]` on the origin line, and in the SAME commit append
//              `- <task text> ([[<source>#^<block>|from]])` under today's
//              daily `### Done today` section (created under `## Done` when
//              absent). Commit-or-nothing: one commit carries both edits.
//   - defer  → rewrite (or insert) the `📅 YYYY-MM-DD` due token to
//              `deferUntil`; the task stays open, one commit.
//   - keep   → touch nothing, record nothing, commit nothing. It keeps the
//              direct task-review surface tri-state and explicit.
//
// The line mechanics (find-by-anchor, flip-if-open, rewrite-📅) are the shared
// pure transforms in `dome.daily`'s `task-disposition` module. The controlled
// mutation Module owns expected-byte CAS, commit, checkout repair, and
// recovery for the resulting file set.
//
// Mutation-boundary note: like `src/surface/capture.ts`, this is the human-side
// write path at the compiler boundary — an edit + `git commit` in one verb, not
// an engine write path. Whitelisted in
// `tests/integration/no-direct-mutation-outside-boundaries.test.ts`.

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  dailyPath,
  localDateParts,
  previousLocalDate,
} from "../../assets/extensions/dome.daily/processors/daily-paths";
import { DEFAULT_DAILY_PATH_SETTINGS } from "../../assets/extensions/dome.daily/processors/daily-types";
import { renderDailySkeleton } from "../../assets/extensions/dome.daily/processors/daily-scaffold";
import {
  actionExtractionLineRanges,
  lineIsInsideRanges,
} from "../../assets/extensions/dome.daily/processors/action-extraction";
import {
  appendDoneTodayBullet,
  findAnchorLine,
  setCheckboxMark,
  setDueDate,
  taskLineBody,
} from "../../assets/extensions/dome.daily/processors/task-disposition";
import { currentBranch, currentSha, findGitRoot } from "../git";
import {
  applyControlledMutation,
  type ControlledMutationResult,
} from "../mutation/controlled-mutation";
import { resolveVaultPath } from "./resolve-vault";

// ----- Public types ---------------------------------------------------------

export type SettleDisposition = "close" | "defer" | "keep";

export type SettleRequest = {
  readonly blockId: string;
  readonly disposition: SettleDisposition;
  /** YYYY-MM-DD; required iff disposition is `defer`. */
  readonly deferUntil?: string | undefined;
};

/**
 * The data-returning outcome of one settle attempt. `settled` carries the
 * landed `commit` — EXCEPT for `keep`, which records nothing and so has no
 * commit. `not-found` (no line carries the anchor) and `invalid` (bad
 * disposition, or a `defer` missing/malformed `deferUntil`, or a
 * non-initialized vault) both leave the vault untouched.
 */
export type SettleResult =
  | {
      readonly status: "settled";
      readonly blockId: string;
      readonly disposition: SettleDisposition;
      readonly commit?: string;
    }
  | { readonly status: "not-found" | "invalid"; readonly message: string };

/** Injectable clock — drives today's daily path for the `close` record. */
export type SettleDeps = {
  readonly now?: (() => Date) | undefined;
};

/** Wire schema for the settle result document — shared by `dome settle`
 * `--json`, `POST /settle`, and the MCP `settle` tool. */
export const SETTLE_SCHEMA = "dome.settle/v1";

/**
 * Render a `SettleResult` as its `dome.settle/v1` document body — the one
 * serialization shared by all three settle adapters (mirrors
 * `questionRecordJson` in `src/surface/answer.ts`).
 */
export function settleResultJson(result: SettleResult): Record<string, unknown> {
  if (result.status === "settled") {
    return {
      schema: SETTLE_SCHEMA,
      status: "settled",
      block_id: result.blockId,
      disposition: result.disposition,
      commit: result.commit ?? null,
    };
  }
  return {
    schema: SETTLE_SCHEMA,
    status: result.status,
    message: result.message,
  };
}

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

// ----- performSettle ---------------------------------------------------------

export async function performSettle(
  vault: string,
  req: SettleRequest,
  deps: SettleDeps = {},
): Promise<SettleResult> {
  const { blockId, disposition } = req;

  if (disposition !== "close" && disposition !== "defer" && disposition !== "keep") {
    return invalid(
      `unknown disposition '${String(disposition)}': expected close, defer, or keep`,
    );
  }

  // keep — the tri-state no-op. Touch nothing, record nothing, commit nothing.
  if (disposition === "keep") {
    return Object.freeze({ status: "settled" as const, blockId, disposition });
  }

  // defer requires a well-formed target date.
  if (disposition === "defer" && (req.deferUntil === undefined || !YYYY_MM_DD.test(req.deferUntil))) {
    return invalid(
      "defer requires deferUntil as a YYYY-MM-DD date",
    );
  }

  // --- Vault preconditions (mirror performCapture) --------------------------
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
    return invalid("detached HEAD: settling needs a branch; check out a branch first");
  }

  // --- Locate the task line by its ^block-anchor ----------------------------
  const matches = findAnchoredLines(vaultPath, blockId);
  if (matches.length === 0) {
    return Object.freeze({
      status: "not-found" as const,
      message: `no task line carries anchor ^${blockId}`,
    });
  }
  if (matches.length > 1) {
    return invalid(
      `multiple task lines carry anchor ^${blockId}; resolve the duplicate anchors before settling`,
    );
  }

  const { relPath, lineIdx, lines } = matches[0]!;
  const originalLine = lines[lineIdx]!;
  const taskText = taskLineBody(originalLine);

  try {
    const changes =
      disposition === "close"
        ? closeChanges({ vaultPath, relPath, lines, lineIdx, blockId, taskText, deps })
        : deferChanges({ relPath, lines, lineIdx, deferUntil: req.deferUntil! });

    // Idempotent no-op (e.g. close on an already-settled line): nothing to write.
    if (changes.length === 0) {
      return Object.freeze({ status: "settled" as const, blockId, disposition });
    }

    const mutation = await applyControlledMutation({
      vaultPath,
      branch,
      requestId: settleRequestId(req),
      files: changes.map((change) => ({
        path: change.filepath,
        expectedContent: change.expectedContent,
        content: change.content,
      })),
      message: `settle(${disposition}): ${taskText.slice(0, 50)}`,
      author: { name: "dome settle", email: "dome-settle@local" },
    });
    if (mutation.kind !== "committed") return settleMutationFailure(mutation);

    return Object.freeze({
      status: "settled" as const,
      blockId,
      disposition,
      commit: mutation.commit,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return invalid(`settle failed: ${msg}`);
  }
}

// ----- disposition → file changes --------------------------------------------

type FileWrite = {
  readonly filepath: string;
  readonly expectedContent: string | null;
  readonly content: string;
};

function closeChanges(input: {
  vaultPath: string;
  relPath: string;
  lines: string[];
  lineIdx: number;
  blockId: string;
  taskText: string;
  deps: SettleDeps;
}): FileWrite[] {
  const originalLine = input.lines[input.lineIdx]!;
  const originalContent = input.lines.join("\n");
  const closed = setCheckboxMark(originalLine, "x");
  // Already non-open (settled) — idempotent no-op; nothing recorded twice.
  if (closed === null) return [];

  const nextLines = [...input.lines];
  nextLines[input.lineIdx] = closed;
  const originContent = nextLines.join("\n");

  const now = (input.deps.now ?? (() => new Date()))();
  const todayDaily = dailyPath(localDateParts(now), DEFAULT_DAILY_PATH_SETTINGS);
  const bullet = `- ${input.taskText} ([[${stripMd(input.relPath)}#^${input.blockId}|from]])`;

  // When the task lives in today's daily, the checkbox flip and the Done-today
  // append are two edits to ONE file — apply both, commit once.
  if (input.relPath === todayDaily) {
    return [{
      filepath: input.relPath,
      expectedContent: originalContent,
      content: appendDoneTodayBullet(originContent, bullet),
    }];
  }

  const existingDaily = readIfExists(join(input.vaultPath, todayDaily));
  const dailyBase =
    existingDaily ??
    renderDailySkeleton({
      today: localDateParts(now),
      yesterday: previousLocalDate(localDateParts(now)),
    });
  return [
    {
      filepath: input.relPath,
      expectedContent: originalContent,
      content: originContent,
    },
    {
      filepath: todayDaily,
      expectedContent: existingDaily,
      content: appendDoneTodayBullet(dailyBase, bullet),
    },
  ];
}

function deferChanges(input: {
  relPath: string;
  lines: string[];
  lineIdx: number;
  deferUntil: string;
}): FileWrite[] {
  const originalLine = input.lines[input.lineIdx]!;
  const deferred = setDueDate(originalLine, input.deferUntil);
  if (deferred === originalLine) return [];
  const nextLines = [...input.lines];
  nextLines[input.lineIdx] = deferred;
  return [{
    filepath: input.relPath,
    expectedContent: input.lines.join("\n"),
    content: nextLines.join("\n"),
  }];
}

// ----- internals -------------------------------------------------------------

function invalid(message: string): SettleResult {
  return Object.freeze({ status: "invalid" as const, message });
}

function settleRequestId(req: SettleRequest): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      blockId: req.blockId,
      disposition: req.disposition,
      deferUntil: req.deferUntil ?? null,
    }))
    .digest("hex")
    .slice(0, 32);
  return `settle:${req.disposition}:${digest}`;
}

function settleMutationFailure(mutation: Exclude<
  ControlledMutationResult,
  { readonly kind: "committed" }
>): SettleResult {
  switch (mutation.kind) {
    case "busy":
      return invalid("settle failed: mutation lane is busy; retry later");
    case "diverged":
      return invalid(
        `settle failed: ${mutation.commit === null ? "candidate" : `commit ${mutation.commit}`} landed with checkout divergence at ${mutation.paths.join(", ") || "unknown paths"}; recovery required`,
      );
    case "no-commit":
      switch (mutation.reason) {
        case "working-tree-conflict":
          return invalid(
            `settle failed: working tree changed before commit at ${mutation.paths.join(", ") || "the target files"}`,
          );
        case "branch-mismatch":
          return invalid("settle failed: branch changed before commit");
        case "candidate-not-landed":
          return invalid("settle failed: candidate commit did not land");
      }
  }
}

function stripMd(path: string): string {
  return path.replace(/\.md$/, "");
}

/**
 * Scan the vault's markdown for the line whose trailing `^id` anchor equals
 * `blockId` — the block-id identity lookup ([[wiki/specs/task-lifecycle]]
 * §"Block-anchor identity"). Reads the working tree (what the owner sees and
 * what the next commit adopts); `.git` and `.dome` are skipped. Returns the
 * canonical matches. Generated projections, frontmatter, and fenced examples
 * use the same exclusion grammar as daily action extraction; the generated
 * `dome.daily:captured` block remains visible because its tasks are origins.
 * The caller rejects duplicate canonical anchors rather than guessing.
 */
function findAnchoredLines(
  vaultPath: string,
  blockId: string,
): ReadonlyArray<{ relPath: string; lineIdx: number; lines: string[] }> {
  const matches: { relPath: string; lineIdx: number; lines: string[] }[] = [];
  for (const relPath of listMarkdownFiles(vaultPath)) {
    let text: string;
    try {
      text = readFileSync(join(vaultPath, relPath), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const ignoredRanges = actionExtractionLineRanges(text);
    let offset = 0;
    while (offset < lines.length) {
      const lineIdx = findAnchorLine(lines, blockId, offset);
      if (lineIdx === -1) break;
      if (!lineIsInsideRanges(lineIdx + 1, ignoredRanges)) {
        matches.push({ relPath, lineIdx, lines });
      }
      offset = lineIdx + 1;
    }
  }
  return Object.freeze(matches);
}

const SKIP_DIRS = new Set([".git", ".dome", "node_modules"]);

function listMarkdownFiles(vaultPath: string): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(vaultPath, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

function readIfExists(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

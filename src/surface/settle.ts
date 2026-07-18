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

import { compareStrings } from "../core/compare";
import {
  dailyPath,
  dailyPathSettings,
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
  appendDoneTodayBullets,
  doneTodayBacklinkAnchors,
  findAnchorLine,
  isOpenCheckbox,
  setCheckboxMark,
  setDueDate,
  taskLineBody,
} from "../../assets/extensions/dome.daily/processors/task-disposition";
import { openLoopSurfaceSources } from "../../assets/extensions/dome.daily/processors/open-loop-surface";
import { parseBlockAnchor } from "../core/block-anchor";
import {
  currentBranch,
  currentSha,
  findGitRoot,
  isAncestor,
  readBlob,
  statusMatrix,
} from "../git";
import { getAdoptedRef } from "../adopted-ref";
import { resolveCapabilityPolicyDocuments } from "../engine/core/capability-policy";
import {
  applyControlledMutation,
  type ControlledMutationResult,
  type ControlledMutationPlan,
  type PlannedControlledMutationResult,
} from "../mutation/controlled-mutation";
import { resolveVaultPath } from "./resolve-vault";
import {
  TASK_BACKLOG_REVIEW_SCHEMA as SETTLE_BATCH_SCHEMA,
  taskBacklogReviewRequestSchema as settleBatchRequestSchema,
  type TaskBacklogReviewRequest as SettleBatchRequest,
  type TaskBacklogReviewResult as SettleBatchResult,
} from "../../contracts/task-backlog-review";
export {
  TASK_BACKLOG_REVIEW_SCHEMA as SETTLE_BATCH_SCHEMA,
  taskBacklogReviewRequestSchema as settleBatchRequestSchema,
  taskBacklogReviewResultSchema as settleBatchResultSchema,
  type TaskBacklogReviewRequest as SettleBatchRequest,
  type TaskBacklogReviewResult as SettleBatchResult,
} from "../../contracts/task-backlog-review";

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

export type SettleBatchDeps = SettleDeps;

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

/**
 * Atomically review a bounded backlog page. Validation, one global Markdown
 * identity scan, planning, and the one possible commit all run under the
 * controlled-mutation locks. A stale review can therefore never partially
 * land or overwrite newer owner bytes.
 */
export async function performSettleBatch(
  vault: string,
  request: unknown,
  deps: SettleBatchDeps = {},
): Promise<SettleBatchResult> {
  const parsed = settleBatchRequestSchema.safeParse(request);
  if (!parsed.success) {
    return batchError("invalid-request", parsed.error.issues[0]?.message ?? "invalid backlog review request");
  }
  const req = parsed.data;
  const vaultPath = resolveVaultPath(vault);
  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    return batchError("invalid-request", "not an initialized Dome vault; run `dome init` first");
  }
  const branch = await currentBranch(vaultPath);
  if (branch === null) {
    return batchError("conflict", "detached HEAD: backlog review needs a branch", true);
  }

  const decisions = [...req.decisions].sort((a, b) =>
    compareStrings(a.blockId, b.blockId)
  );
  const reviewed = Object.freeze({
    keep: decisions.filter((d) => d.disposition === "keep").length,
    close: decisions.filter((d) => d.disposition === "close").length,
    defer: decisions.filter((d) => d.disposition === "defer").length,
  });
  const requestId = settleBatchRequestId(req.revision, decisions);

  try {
    const mutation = await applyControlledMutation({
      vaultPath,
      branch,
      requestId,
      plan: () => planSettleBatch(vaultPath, branch, req.revision, decisions, deps),
    });
    if (mutation.kind === "committed") {
      return Object.freeze({
        schema: SETTLE_BATCH_SCHEMA,
        status: "settled" as const,
        revision: req.revision,
        reviewed,
        commit: mutation.commit,
        adoptionStatus: "pending" as const,
      });
    }
    if (mutation.kind === "no-changes") {
      return Object.freeze({
        schema: SETTLE_BATCH_SCHEMA,
        status: "settled" as const,
        revision: req.revision,
        reviewed,
        commit: null,
        adoptionStatus: "unchanged" as const,
      });
    }
    return settleBatchMutationFailure(mutation);
  } catch (error) {
    return batchError(
      "outcome-unknown",
      `backlog review outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
      true,
      true,
    );
  }
}

async function planSettleBatch(
  vaultPath: string,
  branch: string,
  revision: string,
  decisions: ReadonlyArray<SettleBatchRequest["decisions"][number]>,
  deps: SettleBatchDeps,
): Promise<ControlledMutationPlan> {
  const adopted = await getAdoptedRef(vaultPath, branch);
  const head = await currentSha(vaultPath);
  if (
    adopted !== revision ||
    head === null ||
    (head !== revision &&
      !(await isAncestor({ path: vaultPath, ancestor: revision, descendant: head })))
  ) {
    return rejectedPlan(
      "stale-review",
      "the adopted task backlog changed; refresh the review before applying decisions",
    );
  }

  const [reviewedConfig, reviewedContentScope] = await Promise.all([
    readBlob({ path: vaultPath, commit: revision, filepath: ".dome/config.yaml" }),
    readBlob({ path: vaultPath, commit: revision, filepath: ".dome/content-scope.yaml" }),
  ]);
  if (reviewedConfig === null) {
    return rejectedPlan(
      "configuration-conflict",
      "the reviewed revision has no .dome/config.yaml",
    );
  }
  const policy = resolveCapabilityPolicyDocuments({
    base: {
      body: reviewedConfig,
      path: `${revision}:.dome/config.yaml`,
    },
    contentScope: reviewedContentScope === null ? null : {
      body: reviewedContentScope,
      path: `${revision}:.dome/content-scope.yaml`,
    },
  });
  if (!policy.ok) {
    return rejectedPlan("configuration-conflict", policy.error);
  }
  let settings: ReturnType<typeof dailyPathSettings>;
  try {
    settings = dailyPathSettings(policy.value.configForExtension("dome.daily"));
  } catch (error) {
    return rejectedPlan(
      "configuration-conflict",
      error instanceof Error ? error.message : String(error),
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  const todayDaily = dailyPath(localDateParts(now), settings);
  const requestedIds = new Set(decisions.map((decision) => decision.blockId));
  const scan = scanMarkdownAnchors(
    vaultPath,
    requestedIds,
    new Set([todayDaily]),
  );
  const reviewedLines = new Map<string, string>();
  const reviewedFiles = new Map<string, {
    lines: ReadonlyArray<string>;
    sources: ReturnType<typeof openLoopSurfaceSources>;
  }>();
  const currentSources = new Map<string, ReturnType<typeof openLoopSurfaceSources>>();

  for (const decision of decisions) {
    const ref = decision.sourceRef;
    if (
      ref.commit !== revision ||
      ref.stableId !== `dome.daily.open-loop:${decision.blockId}` ||
      ref.range.startLine !== ref.range.endLine
    ) {
      return rejectedPlan(
        "identity-conflict",
        `^${decision.blockId} does not carry the exact reviewed source identity`,
      );
    }
    let reviewed = reviewedFiles.get(ref.path);
    if (reviewed === undefined) {
      const content = await readBlob({
        path: vaultPath,
        commit: revision,
        filepath: ref.path,
      });
      reviewed = {
        lines: content?.split("\n") ?? Object.freeze([]),
        sources: content === null
          ? Object.freeze([])
          : openLoopSurfaceSources({ path: ref.path, content, settings }),
      };
      reviewedFiles.set(ref.path, reviewed);
    }
    const reviewedLine = reviewed.lines[ref.range.startLine - 1];
    const admitted = reviewed.sources.find((item) =>
      item.line === ref.range.startLine &&
      item.anchor === decision.blockId &&
      item.stableId === ref.stableId
    );
    if (
      reviewedLine === undefined ||
      findAnchorLine([reviewedLine], decision.blockId) !== 0 ||
      !isOpenCheckbox(reviewedLine) ||
      admitted === undefined
    ) {
      return rejectedPlan(
        "identity-conflict",
        `^${decision.blockId} was not an eligible open task at the reviewed source`,
      );
    }
    const matches = scan.anchors.get(decision.blockId) ?? [];
    if (matches.length !== 1) {
      return rejectedPlan(
        "identity-conflict",
        matches.length === 0
          ? `reviewed task ^${decision.blockId} is missing from the current vault`
          : `reviewed task ^${decision.blockId} has duplicate current anchors`,
      );
    }
    const match = matches[0]!;
    const currentLine = match.line;
    const terminal = terminalLine(reviewedLine, decision);
    if (currentLine !== reviewedLine && currentLine !== terminal) {
      return rejectedPlan(
        "identity-conflict",
        `reviewed task ^${decision.blockId} changed; refresh before applying decisions`,
      );
    }
    if (currentLine === reviewedLine) {
      const currentContent = scan.files.get(match.relPath)!.content;
      let sources = currentSources.get(match.relPath);
      if (sources === undefined) {
        sources = openLoopSurfaceSources({
          path: match.relPath,
          content: currentContent,
          settings,
        });
        currentSources.set(match.relPath, sources);
      }
      const currentAdmitted = sources.some((item) =>
        item.line === match.lineIdx + 1 &&
        item.anchor === decision.blockId &&
        item.stableId === ref.stableId
      );
      if (!currentAdmitted) {
        return rejectedPlan(
          "identity-conflict",
          `reviewed task ^${decision.blockId} moved to an ineligible current source`,
        );
      }
    }
    reviewedLines.set(decision.blockId, reviewedLine);
  }

  const touched = new Set(decisions.map((decision) =>
    (scan.anchors.get(decision.blockId) ?? [])[0]!.relPath
  ));
  if (decisions.some((decision) => decision.disposition === "close")) {
    touched.add(todayDaily);
  }
  const matrix = await statusMatrix(vaultPath);
  const dirty = matrix.filter(([path, h, w, s]) =>
    touched.has(path) && !(h === 1 && w === 1 && s === 1)
  ).map(([path]) => path);
  if (dirty.length > 0) {
    return rejectedPlan(
      "dirty-conflict",
      `review target files have uncommitted owner changes: ${dirty.join(", ")}`,
    );
  }

  type EvolvingFile = { original: string | null; lines: string[] };
  const evolving = new Map<string, EvolvingFile>();
  const fileFor = (path: string): EvolvingFile => {
    const prior = evolving.get(path);
    if (prior !== undefined) return prior;
    const scanned = scan.files.get(path);
    const value = {
      original: scanned?.content ?? null,
      lines: [...(scanned?.lines ?? [])],
    };
    evolving.set(path, value);
    return value;
  };
  const doneBullets: string[] = [];
  const dailyExisting = scan.files.get(todayDaily)?.content ?? null;
  const recordedDoneAnchors = doneTodayBacklinkAnchors(dailyExisting ?? "");

  for (const decision of decisions) {
    if (decision.disposition === "keep") continue;
    const match = (scan.anchors.get(decision.blockId) ?? [])[0]!;
    const file = fileFor(match.relPath);
    const reviewedLine = reviewedLines.get(decision.blockId)!;
    const currentLine = file.lines[match.lineIdx]!;
    if (decision.disposition === "defer") {
      const deferred = setDueDate(reviewedLine, decision.deferUntil);
      if (currentLine === reviewedLine) file.lines[match.lineIdx] = deferred;
      continue;
    }
    const closed = setCheckboxMark(reviewedLine, "x")!;
    if (currentLine === closed) {
      if (!recordedDoneAnchors.has(decision.blockId)) {
        return rejectedPlan(
          "identity-conflict",
          `^${decision.blockId} is closed without its required Done-today record`,
        );
      }
      continue;
    }
    file.lines[match.lineIdx] = closed;
    if (!recordedDoneAnchors.has(decision.blockId)) {
      doneBullets.push(
        `- ${taskLineBody(reviewedLine)} ([[${stripMd(match.relPath)}#^${decision.blockId}|from]])`,
      );
    }
  }

  if (doneBullets.length > 0) {
    const daily = fileFor(todayDaily);
    const base = daily.original === null
      ? renderDailySkeleton({
          today: localDateParts(now),
          yesterday: previousLocalDate(localDateParts(now)),
        })
      : daily.lines.join("\n");
    daily.lines = appendDoneTodayBullets(base, doneBullets).split("\n");
  }

  const files = [...evolving.entries()].flatMap(([path, file]) => {
    const content = file.lines.join("\n");
    return content === file.original ? [] : [{
      path,
      expectedContent: file.original,
      content,
    }];
  }).sort((a, b) => compareStrings(a.path, b.path));
  if (files.length === 0) return Object.freeze({ kind: "no-changes" as const });
  return Object.freeze({
    kind: "apply" as const,
    files: Object.freeze(files),
    message: `task backlog review: ${decisions.length} decisions`,
    author: { name: "dome review", email: "dome-review@local" },
  });
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

type SettleBatchError = Extract<SettleBatchResult, { status: "error" }>["error"];

function batchError(
  error: SettleBatchError,
  message: string,
  retryable = false,
  recoveryRequired = false,
): SettleBatchResult {
  return Object.freeze({
    schema: SETTLE_BATCH_SCHEMA,
    status: "error" as const,
    error,
    message,
    retryable,
    recoveryRequired,
  });
}

function rejectedPlan(code: string, message: string): ControlledMutationPlan {
  return Object.freeze({ kind: "rejected" as const, code, message });
}

function terminalLine(
  reviewedLine: string,
  decision: SettleBatchRequest["decisions"][number],
): string {
  if (decision.disposition === "keep") return reviewedLine;
  if (decision.disposition === "defer") {
    return setDueDate(reviewedLine, decision.deferUntil);
  }
  return setCheckboxMark(reviewedLine, "x") ?? reviewedLine;
}

function settleBatchRequestId(
  revision: string,
  decisions: ReadonlyArray<SettleBatchRequest["decisions"][number]>,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ revision, decisions }))
    .digest("hex");
  return `task-backlog-review:${digest}`;
}

function settleBatchMutationFailure(
  mutation: Exclude<PlannedControlledMutationResult,
    { readonly kind: "committed" | "no-changes" }>,
): SettleBatchResult {
  switch (mutation.kind) {
    case "rejected":
      if (mutation.code === "stale-review") {
        return batchError("stale-review", mutation.message);
      }
      return batchError(
        mutation.code === "dirty-conflict" ||
          mutation.code === "identity-conflict" ||
          mutation.code === "configuration-conflict"
          ? "conflict"
          : "invalid-request",
        mutation.message,
      );
    case "busy":
      return batchError("busy", "the vault mutation lane is busy; retry later", true);
    case "diverged":
      return batchError(
        "outcome-unknown",
        `backlog review requires recovery at ${mutation.paths.join(", ") || "the target files"}`,
        true,
        true,
      );
    case "no-commit":
      return batchError(
        "conflict",
        mutation.reason === "working-tree-conflict"
          ? `review target files changed before commit: ${mutation.paths.join(", ") || "unknown paths"}`
          : mutation.reason === "branch-mismatch"
            ? "the current branch changed before backlog review could commit"
            : "the branch changed while backlog review was committing; refresh and retry",
        true,
      );
  }
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
  const scan = scanMarkdownAnchors(vaultPath, new Set([blockId]));
  return (scan.anchors.get(blockId) ?? []).map((match) => ({
    relPath: match.relPath,
    lineIdx: match.lineIdx,
    lines: scan.files.get(match.relPath)!.lines,
  }));
}

type MarkdownScan = {
  readonly files: ReadonlyMap<string, { content: string; lines: string[] }>;
  readonly anchors: ReadonlyMap<string, ReadonlyArray<{
    relPath: string;
    lineIdx: number;
    line: string;
  }>>;
};

/** One line pass; retains only matched target files plus explicit support files. */
function scanMarkdownAnchors(
  vaultPath: string,
  blockIds: ReadonlySet<string>,
  retainPaths: ReadonlySet<string> = new Set(),
): MarkdownScan {
  const files = new Map<string, { content: string; lines: string[] }>();
  const anchors = new Map<string, Array<{ relPath: string; lineIdx: number; line: string }>>();
  for (const id of blockIds) anchors.set(id, []);
  for (const relPath of listMarkdownFiles(vaultPath)) {
    let text: string;
    try {
      text = readFileSync(join(vaultPath, relPath), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const ignoredRanges = actionExtractionLineRanges(text);
    let matched = false;
    for (const [lineIdx, line] of lines.entries()) {
      const parsed = parseBlockAnchor(line);
      if (
        parsed === null ||
        !blockIds.has(parsed.id) ||
        lineIsInsideRanges(lineIdx + 1, ignoredRanges)
      ) continue;
      anchors.get(parsed.id)!.push({ relPath, lineIdx, line });
      matched = true;
    }
    if (matched || retainPaths.has(relPath)) files.set(relPath, { content: text, lines });
  }
  return Object.freeze({ files, anchors });
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

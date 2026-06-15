// Tool bindings for the ingest agent — composed from the shared vault-tools.
import {
  appendCapturedTaskLines,
  appendOriginMarker,
  CAPTURED_APPEND_MAX_LINES,
  CAPTURED_LINE_MAX_CHARS,
  isCapturedTaskLine,
  isValidCapturedTasksWrite,
} from "../../dome.daily/processors/captured-block";
import { dailyPath, previousLocalDate } from "../../dome.daily/processors/daily-paths";
import { renderDailySkeleton } from "../../dome.daily/processors/daily-scaffold";
import type { DailyDate, DailyPathSettings } from "../../dome.daily/processors/daily-types";
import type { AgentRunState, AgentTool } from "./agent-loop";
import {
  appendToPageTool,
  archiveSourceTool,
  askOwnerTool,
  composePageWriteGuards,
  currentContent,
  listPagesTool,
  readPageTool,
  searchVaultTool,
  signalsAppendOnlyGuard,
  writeDenial,
  writePageTool,
  type PageWriteGuard,
  type VaultReader,
} from "./vault-tools";

export type { VaultReader } from "./vault-tools";

/**
 * Bundle-local mirror of the `dome.agent.ingest` manifest `patch.auto`
 * grant. Pinned to manifest.yaml by the grant-aware-tools manifest-sync
 * test — edit both together.
 *
 * `index.md` and `log.md` are deliberately absent (read grant only, like
 * core.md — the core-memory.ts grant shape): the index is generated from
 * page `description:` frontmatter and log.md is frozen history. The broker
 * verdict is per-PatchEffect (all-or-nothing), so a stray write to either
 * must die HERE at the tool — self-correctable mid-loop — not poison the
 * whole batched patch.
 */
export const INGEST_WRITABLE_PATHS: ReadonlyArray<string> = Object.freeze([
  "wiki/**/*.md",
  "notes/**/*.md",
  "inbox/processed/*.md",
  "inbox/raw/*.md",
  "preferences/signals.md",
]);

/**
 * Today's daily as a captured-tasks landing zone — the routing data the
 * captured seam needs ([[wiki/specs/daily-surface]] §"The ingest tool
 * seam"). `path` must equal `dailyPath(today, settings)`; the processor
 * derives all three from one clock read so they cannot disagree.
 */
export type CapturedTasksRouting = {
  /** Today's daily note path — the only daily ingest may write. */
  readonly path: string;
  readonly today: DailyDate;
  readonly settings: DailyPathSettings;
  /**
   * Mutable per-source origin target the seam stamps onto each spliced task
   * line as an inline ` ([↗](origin))` marker. Ingest sets it to the current
   * capture's archived path before each source-loop iteration; absent/null =
   * no marker. Phase 2 sets it to an external (Slack) permalink instead.
   */
  origin?: string | null;
};

export function makeIngestTools(opts: {
  readonly reader: VaultReader;
  readonly capturedTasks?: CapturedTasksRouting;
}): ReadonlyArray<AgentTool> {
  const { reader, capturedTasks } = opts;
  // preferences/signals.md is writable but append-only: the guard rejects
  // rewrites/deletions at tool time so the model cannot touch the owner's
  // rejection tombstones (same rule the brief enforces at splice time).
  // Today's daily stacks the captured-tasks guard on top: ingest may write
  // it only as an in-block task-line append.
  const guard =
    capturedTasks === undefined
      ? signalsAppendOnlyGuard(reader)
      : composePageWriteGuards(
          signalsAppendOnlyGuard(reader),
          capturedTasksWriteGuard(reader, capturedTasks),
        );
  const baseAppend = appendToPageTool(reader, INGEST_WRITABLE_PATHS, guard);
  return [
    readPageTool(reader),
    listPagesTool(reader),
    searchVaultTool(reader),
    writePageTool(INGEST_WRITABLE_PATHS, guard),
    capturedTasks === undefined
      ? baseAppend
      : capturedAwareAppendTool({ base: baseAppend, reader, capturedTasks }),
    archiveSourceTool(reader, INGEST_WRITABLE_PATHS),
    askOwnerTool("dome.agent.ingest:"),
  ];
}

/**
 * The captured-tasks seam over `appendToPage` (mirrors the signals
 * append-only guard's tool-time posture): an append targeting TODAY's daily
 * must be task-shaped lines, and the SEAM — not the model — splices them
 * inside the `dome.daily:captured` block, creating the shared skeleton when
 * the daily doesn't exist yet (so create-daily/the brief later no-op).
 * Every other path falls through to the plain append tool.
 */
function capturedAwareAppendTool(opts: {
  readonly base: AgentTool;
  readonly reader: VaultReader;
  readonly capturedTasks: CapturedTasksRouting;
}): AgentTool {
  const { base, reader, capturedTasks } = opts;
  return {
    schema: base.schema,
    execute: async (input, state) => {
      const { path, content } = input as { path: string; content: string };
      if (path !== capturedTasks.path) return base.execute(input, state);
      const denial = writeDenial(path, INGEST_WRITABLE_PATHS);
      if (denial !== null) return denial;
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "");
      // Size caps before shape validation, so the model gets the specific
      // self-correctable error rather than the generic shape one
      // ([[wiki/specs/daily-surface]] §"The ingest tool seam").
      if (lines.length > CAPTURED_APPEND_MAX_LINES) {
        return (
          `error: appends to today's daily (${path}) are capped at ` +
          `${CAPTURED_APPEND_MAX_LINES} task lines per call (got ${lines.length}) — ` +
          "keep only today's genuinely tactical tasks, or split the append " +
          "into smaller calls."
        );
      }
      const overLong = lines.find(
        (line) => line.length > CAPTURED_LINE_MAX_CHARS,
      );
      if (overLong !== undefined) {
        return (
          `error: a task line appended to today's daily (${path}) is ` +
          `${overLong.length} chars — the captured seam caps lines at ` +
          `${CAPTURED_LINE_MAX_CHARS} chars. Compress the task description; ` +
          "details belong in a linked note, not the task line."
        );
      }
      if (lines.length === 0 || !lines.every(isCapturedTaskLine)) {
        return (
          `error: appends to today's daily (${path}) must contain ONLY open task ` +
          "lines shaped `- [ ] #task <description> …` (or `#followup`) — no " +
          "headings, prose, settled checkboxes, HTML comments, or " +
          "`(from [[…]])` suffixes. The tool routes valid lines into the " +
          "`## Captured today` block automatically."
        );
      }
      const existing = await currentContent(path, state, reader);
      const blank = existing === null || existing.trim() === "";
      const target = blank
        ? await todaySkeleton(capturedTasks, state, reader)
        : existing;
      const origin = capturedTasks.origin ?? null;
      const stamped =
        origin === null
          ? lines
          : lines.map((line) => appendOriginMarker(line, origin));
      const next = appendCapturedTaskLines({ content: target, lines: stamped });
      state.edits.set(path, { kind: "write", path, content: next });
      return `appended ${lines.length} task line(s) inside the '## Captured today' block of ${path}`;
    },
  };
}

/**
 * The `writePage` mirror of the captured seam: a full rewrite of today's
 * daily is admitted only when it amounts to the same in-block task-line
 * append (byte-identical outside the block); anything else — including
 * deletion — is rejected with appendToPage guidance. Other daily notes are
 * untouched by this guard (the glob grant governs them).
 */
function capturedTasksWriteGuard(
  reader: VaultReader,
  capturedTasks: CapturedTasksRouting,
): PageWriteGuard {
  return async ({ path, nextContent, state }) => {
    if (path !== capturedTasks.path) return null;
    if (nextContent === null) {
      return `error: today's daily note (${path}) cannot be deleted.`;
    }
    const before = await currentContent(path, state, reader);
    // A byte-identical rewrite is a harmless no-op, not a violation.
    if (before !== null && nextContent === before) return null;
    if (
      before === null ||
      !isValidCapturedTasksWrite({ before, after: nextContent })
    ) {
      return (
        `error: ingest may write today's daily (${path}) only by appending ` +
        "task lines inside the `## Captured today` block — use appendToPage " +
        "with `- [ ] #task …` lines (the tool places them); other daily " +
        "edits belong to the brief and the owner."
      );
    }
    return null;
  };
}

async function todaySkeleton(
  capturedTasks: CapturedTasksRouting,
  state: AgentRunState,
  reader: VaultReader,
): Promise<string> {
  const yesterday = previousLocalDate(capturedTasks.today);
  const yesterdayExists =
    (await currentContent(
      dailyPath(yesterday, capturedTasks.settings),
      state,
      reader,
    )) !== null;
  return renderDailySkeleton({
    today: capturedTasks.today,
    yesterday: yesterdayExists ? yesterday : null,
    settings: capturedTasks.settings,
  });
}

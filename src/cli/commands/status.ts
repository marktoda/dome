import { openVault } from "../../vault";
import { getAdoptionStatus, type AdoptionStatus } from "../../adoption";
import { ok, type Result, type ToolError } from "../../types";

export interface DomeStatusOutput {
  /** Human-readable lines for the text-mode CLI. */
  readonly lines: ReadonlyArray<string>;
  /** Structured snapshot for `--json` output. */
  readonly status: AdoptionStatus;
}

/**
 * `dome status` — read-only snapshot of the vault's adoption state.
 * See docs/wiki/specs/adoption.md §"`dome status`".
 */
export async function domeStatus(vaultPath: string): Promise<Result<DomeStatusOutput, ToolError>> {
  const openRes = await openVault(vaultPath);
  if (!openRes.ok) return openRes;
  const vault = openRes.value;
  try {
    const status = await getAdoptionStatus(vault);
    return ok({ lines: renderStatusLines(status), status });
  } finally {
    await vault.close();
  }
}

function renderStatusLines(s: AdoptionStatus): string[] {
  const lines: string[] = [];
  lines.push(`branch:   ${s.branch ?? "(detached HEAD)"}`);
  lines.push(`HEAD:     ${s.head ?? "(no commits yet)"}`);

  if (s.adopted === null) {
    lines.push("adopted:  (uninitialized — first `dome sync` will initialize at HEAD)");
    lines.push("pending:  n/a");
  } else if (s.diverged) {
    lines.push(
      `adopted:  ${s.adopted.slice(0, 7)} (DIVERGED — not an ancestor of HEAD; run \`dome sync --force-advance\` after confirming)`,
    );
    lines.push("pending:  n/a");
  } else {
    const pending = s.pendingCommits ?? 0;
    const behind = pending === 0 ? "(adopted == HEAD)" : `(${pending} commits behind HEAD)`;
    lines.push(`adopted:  ${s.adopted} ${behind}`);
    lines.push(`pending:  ${pending} commits to adopt`);
  }

  lines.push(`dirty:    ${s.dirty.modified} modified, ${s.dirty.untracked} untracked`);
  return lines;
}

/**
 * Render the structured snapshot as the `--json` payload. The shape
 * mirrors `dome stats --json` for consumer parity.
 */
export function statusToJson(s: AdoptionStatus): string {
  return JSON.stringify(
    {
      branch: s.branch,
      head: s.head,
      adopted: s.adopted,
      pendingCommits: s.pendingCommits,
      dirty: s.dirty,
      diverged: s.diverged,
    },
    null,
    2,
  );
}

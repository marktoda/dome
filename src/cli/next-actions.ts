export type CliNextAction = {
  readonly reasons: ReadonlyArray<string>;
  readonly command: string | null;
  readonly description: string;
};

const DIRTY_REASONS = Object.freeze(["dirty_modified", "dirty_untracked"]);
const SYNC_REASONS = Object.freeze([
  "sync_needed",
  "projection_stale",
  "outbox_pending",
]);
const CHECK_REASONS = Object.freeze([
  "adopted_ref_diverged",
  "pending_runs",
  "failed_runs",
  "serve_stale",
  "diagnostics",
  "questions",
  "outbox_failed",
  "quarantined",
]);

export function nextActionsForStatus(
  attention: ReadonlyArray<string>,
): ReadonlyArray<CliNextAction> {
  const out: CliNextAction[] = [];
  pushAction(out, attention, DIRTY_REASONS, {
    command: "git status --short",
    description:
      "Review draft working-tree changes; commit anything Dome should compile.",
  });
  pushAction(out, attention, SYNC_REASONS, {
    command: "dome sync --json",
    description:
      "Run one compiler tick to adopt pending commits or drain due operational work.",
  });
  pushAction(out, attention, CHECK_REASONS, {
    command: "dome check --json",
    description:
      "Explain remaining compiler attention across engine health, content diagnostics, and open decisions.",
  });
  return Object.freeze(out);
}

export function nextActionsForCheck(input: {
  readonly engineFindings: number;
  readonly diagnostics: number;
  readonly questions: number;
  readonly firstQuestionId: number | null;
}): ReadonlyArray<CliNextAction> {
  const out: CliNextAction[] = [];
  if (input.questions > 0) {
    out.push(Object.freeze({
      reasons: Object.freeze(["questions"]),
      command: input.firstQuestionId === null
        ? "dome resolve <question-id> <choice>"
        : `dome resolve ${input.firstQuestionId} <choice>`,
      description:
        "Resolve an open Dome decision after choosing the correct option.",
    }));
  }
  if (input.engineFindings > 0) {
    out.push(Object.freeze({
      reasons: Object.freeze(["engine"]),
      command: "dome sync --json",
      description:
        "Run the compiler so health processors can raise recovery questions; rerun dome check if findings remain.",
    }));
  }
  if (input.diagnostics > 0) {
    out.push(Object.freeze({
      reasons: Object.freeze(["diagnostics"]),
      command: "dome check --content --limit 50 --json",
      description:
        "Review a larger bounded diagnostic list; fix the source markdown issue(s), commit, then run dome sync --json.",
    }));
  }
  return Object.freeze(out);
}

function pushAction(
  out: CliNextAction[],
  attention: ReadonlyArray<string>,
  candidates: ReadonlyArray<string>,
  action: Omit<CliNextAction, "reasons">,
): void {
  const reasons = candidates.filter((reason) => attention.includes(reason));
  if (reasons.length === 0) return;
  out.push(Object.freeze({
    reasons: Object.freeze(reasons),
    ...action,
  }));
}

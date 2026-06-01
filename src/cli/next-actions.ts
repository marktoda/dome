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

const SYNC_RETRY_REASONS = Object.freeze([
  "compiler_host_busy",
  "outbox_pending",
]);

const SYNC_CHECK_REASONS = Object.freeze([
  "adoption_blocked",
  "garden_rejected_patches",
  "garden_diagnostics",
  "operational_diagnostics",
  "pending_runs",
  "failed_runs",
  "diagnostics",
  "questions",
  "outbox_failed",
  "quarantined",
]);

export function nextActionsForStatus(
  input: {
    readonly attention: ReadonlyArray<string>;
  },
): ReadonlyArray<CliNextAction> {
  const out: CliNextAction[] = [];
  const { attention } = input;
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

  const checkReasons = CHECK_REASONS.filter((reason) =>
    attention.includes(reason),
  );
  const nonDiagnosticCheckReasons = checkReasons.filter(
    (reason) => reason !== "diagnostics",
  );
  if (nonDiagnosticCheckReasons.length > 0) {
    out.push(Object.freeze({
      reasons: Object.freeze(checkReasons),
      command: "dome check --json",
      description:
        "Explain remaining compiler attention across engine health, content diagnostics, and open decisions.",
    }));
  } else if (checkReasons.includes("diagnostics")) {
    out.push(Object.freeze({
      reasons: Object.freeze(["diagnostics"]),
      command: "dome check --content --attention --limit 50 --json",
      description:
        "Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json.",
    }));
  }
  return Object.freeze(out);
}

export function nextActionsForSync(input: {
  readonly attention: ReadonlyArray<string>;
}): ReadonlyArray<CliNextAction> {
  const out: CliNextAction[] = [];
  const { attention } = input;

  pushAction(out, attention, SYNC_RETRY_REASONS, {
    command: "dome sync --json",
    description:
      "Run another compiler tick after the active host or pending operational work clears.",
  });

  const checkReasons = SYNC_CHECK_REASONS.filter((reason) =>
    attention.includes(reason),
  );
  const nonDiagnosticCheckReasons = checkReasons.filter(
    (reason) => reason !== "diagnostics",
  );
  if (nonDiagnosticCheckReasons.length > 0) {
    out.push(Object.freeze({
      reasons: Object.freeze(checkReasons),
      command: "dome check --json",
      description:
        "Explain remaining compiler attention across engine health, content diagnostics, and open decisions.",
    }));
  } else if (checkReasons.includes("diagnostics")) {
    out.push(Object.freeze({
      reasons: Object.freeze(["diagnostics"]),
      command: "dome check --content --attention --limit 50 --json",
      description:
        "Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json.",
    }));
  }

  pushAction(out, attention, ["detached_head"], {
    command: "git status --short --branch",
    description:
      "Check out a branch before syncing; the adopted-ref substrate cannot run on detached HEAD.",
  });

  pushAction(out, attention, ["no_commits"], {
    command: "git status --short",
    description:
      "Create an initial git commit for the vault, then rerun dome sync --json.",
  });

  pushAction(out, attention, ["adopted_ref_diverged"], {
    command: "git log --oneline --decorate --graph --all -20",
    description:
      "Inspect rewritten branch history before choosing the adopted-ref recovery path.",
  });

  return Object.freeze(out);
}

export function nextActionsForCheck(input: {
  readonly engineFindings: number;
  readonly diagnostics: number;
  readonly diagnosticsAlreadyBounded: boolean;
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
    if (input.diagnosticsAlreadyBounded) {
      out.push(Object.freeze({
        reasons: Object.freeze(["diagnostics"]),
        command: null,
        description:
          "Fix the listed source markdown diagnostics, commit the changes, then run dome sync --json.",
      }));
    } else {
      out.push(Object.freeze({
        reasons: Object.freeze(["diagnostics"]),
        command: "dome check --content --attention --limit 50 --json",
        description:
          "Review a larger bounded attention-diagnostic list; fix the source markdown issue(s), commit, then run dome sync --json.",
      }));
    }
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

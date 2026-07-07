import type { StatusReason } from "./attention-reasons";
import {
  questionResolutionDescription,
  resolveQuestionCommand,
} from "../question-resolution";

export type CliNextAction = {
  readonly reasons: ReadonlyArray<string>;
  readonly command: string | null;
  readonly description: string;
};

export function formatCliNextAction(action: CliNextAction): string {
  if (action.command === null) {
    return `manual: ${action.description}`;
  }
  return `${action.command} - ${action.description}`;
}

// Status-path reason buckets. Typed to the closed StatusReason vocabulary so a
// stray or misspelled code is a compile error here, not a silent miss.
const DIRTY_REASONS: ReadonlyArray<StatusReason> = Object.freeze([
  "dirty_modified",
  "dirty_untracked",
]);
const SYNC_REASONS: ReadonlyArray<StatusReason> = Object.freeze([
  "sync_needed",
  "projection_stale",
  "outbox_pending",
]);
const CHECK_REASONS: ReadonlyArray<StatusReason> = Object.freeze([
  "pending_runs",
  "failed_runs",
  "diagnostics",
  "questions",
  "outbox_failed",
  "quarantined",
]);
const CAPTURE_REASONS: ReadonlyArray<StatusReason> = Object.freeze([
  "capture_loop_inactive",
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
    readonly attention: ReadonlyArray<StatusReason>;
    readonly dirtyModified?: number;
    readonly dirtyUntracked?: number;
    readonly dirtyModifiedPaths?: ReadonlyArray<string>;
    readonly dirtyUntrackedPaths?: ReadonlyArray<string>;
    readonly pendingProposals?: number;
  },
): ReadonlyArray<CliNextAction> {
  const out: CliNextAction[] = [];
  const {
    attention,
    dirtyModified = 0,
    dirtyUntracked = 0,
    dirtyModifiedPaths = [],
    dirtyUntrackedPaths = [],
    pendingProposals = 0,
  } = input;
  pushAction(out, attention, DIRTY_REASONS, {
    command: "git status --short",
    description: dirtyStatusDescription({
      dirtyModified,
      dirtyUntracked,
      dirtyModifiedPaths,
      dirtyUntrackedPaths,
    }),
  });
  pushAction(out, attention, CAPTURE_REASONS, {
    command: "dome inspect bundles --json",
    description:
      "Raw captures are waiting but the capture digestion loop is inactive " +
      "or not model-ready; inspect dome.agent, enable it in " +
      ".dome/config.yaml when ready, commit, then run dome sync --json.",
  });
  pushAction(out, attention, ["pending_proposals"], {
    command: "dome proposals",
    description: pendingProposalsDescription(pendingProposals),
  });
  pushAction(out, attention, ["adopted_ref_diverged"], {
    command: "dome reanchor",
    description:
      "The branch history was rewritten under the adopted ref. Inspect " +
      "both sides (git log --oneline HEAD..<adopted>), then run dome " +
      "reanchor to accept the rewritten HEAD (the old adopted SHA is " +
      "backed up under refs/dome/backup/), or restore the prior history " +
      "via git reflog.",
  });
  pushAction(out, attention, ["serve_stale"], {
    command: "dome serve",
    description:
      "Restart the foreground compiler host so it can refresh the stale serve heartbeat.",
  });
  pushAction(out, attention, ["service_not_loaded"], {
    command: "dome restart",
    description:
      "The vault's launchd service plist is installed but the service is " +
      "not loaded; restart it from the existing plist (bootout + bootstrap; " +
      "--env entries preserved).",
  });
  pushAction(out, attention, ["model_provider_unreachable"], {
    command: "dome doctor --json",
    description:
      "The last model-provider probe failed; re-probe and follow the " +
      "model.provider-unreachable finding's recovery to fix the provider " +
      "command or its environment.",
  });
  const syncReasons = SYNC_REASONS.filter((reason) =>
    attention.includes(reason),
  );
  if (syncReasons.length > 0) {
    appendAction(out, {
      reasons: Object.freeze(syncReasons),
      command: "dome sync --json",
      description: syncStatusDescription(syncReasons),
    });
  }

  const checkReasons = CHECK_REASONS.filter((reason) =>
    attention.includes(reason),
  );
  const nonDiagnosticCheckReasons = checkReasons.filter(
    (reason) => reason !== "diagnostics",
  );
  if (nonDiagnosticCheckReasons.length > 0) {
    appendAction(out, {
      reasons: Object.freeze(checkReasons),
      command: "dome check --json",
      description:
        "Explain remaining compiler attention across engine health, content diagnostics, and open decisions.",
    });
  } else if (checkReasons.includes("diagnostics")) {
    appendAction(out, {
      reasons: Object.freeze(["diagnostics"]),
      command: "dome check --content --attention --limit 50 --json",
      description:
        "Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json.",
    });
  }
  return Object.freeze(out);
}

function pendingProposalsDescription(pendingProposals: number): string {
  return `${pendingProposals} proposals awaiting review — list with dome proposals, then decide each with dome apply <id> or dome reject <id>`;
}

function dirtyStatusDescription(input: {
  readonly dirtyModified: number;
  readonly dirtyUntracked: number;
  readonly dirtyModifiedPaths: ReadonlyArray<string>;
  readonly dirtyUntrackedPaths: ReadonlyArray<string>;
}): string {
  const detail = dirtyPathDetail(input);
  return detail === ""
    ? "Review draft working-tree changes; commit anything Dome should compile."
    : `Review draft working-tree changes (${detail}); commit anything Dome should compile.`;
}

function dirtyPathDetail(input: {
  readonly dirtyModified: number;
  readonly dirtyUntracked: number;
  readonly dirtyModifiedPaths: ReadonlyArray<string>;
  readonly dirtyUntrackedPaths: ReadonlyArray<string>;
}): string {
  const parts: string[] = [];
  const modified = formatDirtyPathGroup({
    label: "modified",
    total: input.dirtyModified,
    paths: input.dirtyModifiedPaths,
  });
  if (modified !== "") parts.push(modified);
  const untracked = formatDirtyPathGroup({
    label: "untracked",
    total: input.dirtyUntracked,
    paths: input.dirtyUntrackedPaths,
  });
  if (untracked !== "") parts.push(untracked);
  return parts.join("; ");
}

function formatDirtyPathGroup(input: {
  readonly label: string;
  readonly total: number;
  readonly paths: ReadonlyArray<string>;
}): string {
  if (input.total === 0) return "";
  if (input.paths.length === 0) {
    return `${input.label}: ${input.total}`;
  }
  const omitted = input.total - input.paths.length;
  const suffix = omitted > 0 ? `, +${omitted} more` : "";
  return `${input.label}: ${input.paths.join(", ")}${suffix}`;
}

function syncStatusDescription(reasons: ReadonlyArray<string>): string {
  if (reasons.length === 1 && reasons[0] === "projection_stale") {
    return "Run one compiler tick to rebuild stale projections from adopted markdown.";
  }
  return "Run one compiler tick to adopt pending commits or drain due operational work.";
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
    appendAction(out, {
      reasons: Object.freeze(checkReasons),
      command: "dome check --json",
      description:
        "Explain remaining compiler attention across engine health, content diagnostics, and open decisions.",
    });
  } else if (checkReasons.includes("diagnostics")) {
    appendAction(out, {
      reasons: Object.freeze(["diagnostics"]),
      command: "dome check --content --attention --limit 50 --json",
      description:
        "Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json.",
    });
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
      "Inspect the rewritten branch history, then run dome reanchor to " +
      "accept the new HEAD (the old adopted SHA is backed up under " +
      "refs/dome/backup/), or restore the prior history via git reflog.",
  });

  return Object.freeze(out);
}

export function nextActionsForCheck(input: {
  readonly engineFindings: number;
  readonly projectionStale: boolean;
  readonly diagnostics: number;
  readonly diagnosticsAlreadyBounded: boolean;
  readonly questions: number;
  readonly firstQuestionId: number | null;
  readonly firstQuestionOptions: ReadonlyArray<string> | null;
}): ReadonlyArray<CliNextAction> {
  const out: CliNextAction[] = [];
  if (input.engineFindings > 0) {
    appendAction(out, {
      reasons: Object.freeze(["engine"]),
      command: "dome sync --json",
      description:
        "Run the compiler so health processors can raise recovery questions; rerun dome check if findings remain.",
    });
  }
  if (input.projectionStale) {
    appendAction(out, {
      reasons: Object.freeze(["projection_stale"]),
      command: "dome sync --json",
      description:
        "Rebuild stale projection rows before relying on projection-backed diagnostics or questions.",
    });
  }
  if (input.diagnostics > 0) {
    if (input.diagnosticsAlreadyBounded) {
      appendAction(out, {
        reasons: Object.freeze(["diagnostics"]),
        command: null,
        description:
          "Fix the listed source markdown diagnostics, commit the changes, then run dome sync --json.",
      });
    } else {
      appendAction(out, {
        reasons: Object.freeze(["diagnostics"]),
        command: "dome check --content --attention --limit 50 --json",
        description:
          "Review a larger bounded attention-diagnostic list; fix the source markdown issue(s), commit, then run dome sync --json.",
      });
    }
  }
  if (input.questions > 0) {
    appendAction(out, {
      reasons: Object.freeze(["questions"]),
      command: resolveQuestionCommand({
        id: input.firstQuestionId,
        options: input.firstQuestionOptions,
      }),
      description: questionResolutionDescription(input.firstQuestionOptions),
    });
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
  appendAction(out, {
    reasons: Object.freeze(reasons),
    ...action,
  });
}

function appendAction(out: CliNextAction[], action: CliNextAction): void {
  const existingIndex = out.findIndex((candidate) =>
    actionKey(candidate) === actionKey(action)
  );
  if (existingIndex < 0) {
    out.push(freezeAction(action));
    return;
  }
  const existing = out[existingIndex];
  if (existing === undefined) {
    out.push(freezeAction(action));
    return;
  }
  out[existingIndex] = freezeAction({
    command: existing.command,
    reasons: uniqueStrings([...existing.reasons, ...action.reasons]),
    description: mergeDescriptions(existing.description, action.description),
  });
}

function actionKey(action: CliNextAction): string {
  return action.command === null
    ? `manual:${action.description}`
    : `command:${action.command}`;
}

function mergeDescriptions(a: string, b: string): string {
  if (a === b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a} Also: ${b}`;
}

function uniqueStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze([...new Set(values)]);
}

function freezeAction(action: CliNextAction): CliNextAction {
  return Object.freeze({
    command: action.command,
    reasons: Object.freeze([...action.reasons]),
    description: action.description,
  });
}

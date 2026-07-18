import {
  type SetupApplyResult,
  type SetupPlan,
  validateSetupApplyResult,
  validateSetupPlan,
} from "./contracts";
import { setupPlanSha256 } from "./consent";

/** Both product presentations consume the exact same validated plan. */
export function renderSetupPlanJson(input: SetupPlan): string {
  return JSON.stringify(validateSetupPlan(input), null, 2);
}

export function renderSetupPlanHuman(input: SetupPlan): string {
  const plan = validateSetupPlan(input);
  const lines = [
    "Dome setup preview",
    `Vault: ${plan.assessment.target.path}`,
    `Scope: ${plan.scope}`,
    `Status: ${plan.status}`,
    `Classification: ${plan.assessment.target.kind}`,
    `Revision: ${plan.assessment.revision.head ?? "no Git HEAD"} / ${plan.assessment.revision.worktreeFingerprint}`,
    "",
  ];
  if (plan.status === "blocked") {
    lines.push("Blockers:");
    for (const blocker of plan.assessment.blockers) {
      lines.push(`- ${blocker.message}`, `  Next: ${blocker.nextAction}`);
    }
  } else {
    if (plan.assessment.git.state === "absent") {
      const baseline = plan.assessment.repository.baselineTracked;
      lines.push(
        "Proposed owner baseline:",
        ...(baseline.length === 0 ? ["- No pre-existing owner files"] : baseline.map((path) => `- ${path}`)),
        "",
      );
    }
    lines.push("Planned actions:");
    for (const action of plan.actions) lines.push(`- ${describeAction(action)}`);
    if (plan.optionalSteps.length > 0) {
      lines.push("", "Optional after setup:");
      for (const step of plan.optionalSteps) lines.push(`- ${step.description}`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) lines.push(`- ${warning.message}`);
  }
  lines.push("", "Deferred (not applied by this plan):");
  for (const step of plan.deferredSteps) lines.push(`- ${step.description} (${step.milestone})`);
  const excluded = plan.assessment.repository.candidates.filter((candidate) => candidate.disposition !== "baseline");
  if (excluded.length > 0) {
    lines.push("", "Repository inventory not proposed for the owner baseline:");
    for (const candidate of excluded) {
      lines.push(`- ${candidate.path} (${candidate.reason}; ${candidate.disposition})`);
    }
  }
  if (plan.status === "ready") {
    const digest = setupPlanSha256(plan);
    lines.push(
      "",
      `Consent digest: ${digest}`,
      'Plan file: PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/dome-setup-plan.XXXXXX")"',
      `Save: dome setup ${shellArgument(plan.assessment.target.path)} --dry-run --json > "$PLAN_FILE"`,
      `Apply: dome setup ${shellArgument(plan.assessment.target.path)} --apply --plan "$PLAN_FILE" --consent ${digest}`,
    );
  }
  lines.push("", "No changes were made.");
  return lines.join("\n");
}

export function renderSetupApplyResultJson(input: SetupApplyResult): string {
  return JSON.stringify(validateSetupApplyResult(input), null, 2);
}

export function renderSetupApplyResultHuman(input: SetupApplyResult): string {
  const result = validateSetupApplyResult(input);
  if (result.status === "completed") {
    const lines = [
      "Dome setup complete",
      `Vault: ${result.targetPath}`,
      `Consent digest: ${result.planSha256}`,
    ];
    if (result.commits.baseline !== null) lines.push(`Owner baseline commit: ${result.commits.baseline}`);
    if (result.commits.configuration !== null) lines.push(`Dome configuration commit: ${result.commits.configuration}`);
    lines.push("Home was not installed or changed.");
    return lines.join("\n");
  }
  if (result.status === "stale") {
    return [
      "Dome setup plan changed",
      `Approved digest: ${result.planSha256}`,
      "The vault was reassessed and no changes were made.",
      "",
      renderSetupPlanHuman(result.freshPlan),
    ].join("\n");
  }
  return [
    "Dome setup blocked",
    `Consent digest: ${result.planSha256}`,
    `Reason: ${result.recovery.message}`,
    ...(result.recovery.commands.length === 0
      ? []
      : ["", "Recovery:", ...result.recovery.commands.map((command) => `- ${command}`)]),
    "No Home or service changes were made.",
  ].join("\n");
}

function describeAction(action: SetupPlan["actions"][number]): string {
  if (action.kind === "create-vault-directory") return `Create vault directory ${action.path}`;
  if (action.kind === "initialize-git") return `Initialize Git at ${action.repositoryPath}`;
  if (action.kind === "commit-owner-baseline") return `Commit ${action.paths.length} owner baseline file${action.paths.length === 1 ? "" : "s"}`;
  if (action.kind === "ensure-scaffold-directory") return `Ensure ${action.path}`;
  if (action.kind === "write-scaffold-file") return `Create ${action.path} if missing`;
  if (action.kind === "set-content-scope") return `Configure Markdown scope in ${action.write.path}`;
  return assertNever(action);
}

function assertNever(value: never): never {
  throw new Error(`unknown setup action: ${String(value)}`);
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

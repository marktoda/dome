import { type SetupPlan, validateSetupPlan } from "./contracts";

/** Both product presentations consume the exact same validated plan. */
export function renderSetupPlanJson(input: SetupPlan): string {
  return JSON.stringify(validateSetupPlan(input), null, 2);
}

export function renderSetupPlanHuman(input: SetupPlan): string {
  const plan = validateSetupPlan(input);
  const lines = [
    "Dome setup preview",
    `Vault: ${plan.assessment.target.path}`,
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
  const excluded = plan.assessment.repository.candidates.filter((candidate) => candidate.disposition !== "baseline");
  if (excluded.length > 0) {
    lines.push("", "Repository inventory not proposed for the owner baseline:");
    for (const candidate of excluded) {
      lines.push(`- ${candidate.path} (${candidate.reason}; ${candidate.disposition})`);
    }
  }
  lines.push("", "No changes were made.");
  return lines.join("\n");
}

function describeAction(action: SetupPlan["actions"][number]): string {
  if (action.kind === "create-vault-directory") return `Create vault directory ${action.path}`;
  if (action.kind === "initialize-git") return `Initialize Git at ${action.repositoryPath}`;
  if (action.kind === "ensure-scaffold-directory") return `Ensure ${action.path}`;
  if (action.kind === "write-scaffold-file") return `Create ${action.path} if missing`;
  if (action.kind === "set-content-scope") return `Configure Markdown scope in ${action.write.path}`;
  return `${action.disposition === "upgrade" ? "Upgrade" : "Install or resume"} packaged Dome Home and activate ${action.serviceLabel}`;
}

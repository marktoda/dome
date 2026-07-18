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
    lines.push("Planned actions:");
    for (const action of plan.assessment.actions) lines.push(`- ${describeAction(action)}`);
    if (plan.optionalSteps.length > 0) {
      lines.push("", "Optional after setup:");
      for (const step of plan.optionalSteps) lines.push(`- ${step.description}`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of plan.warnings) lines.push(`- ${warning.message}`);
  }
  lines.push("", "No changes were made.");
  return lines.join("\n");
}

function describeAction(action: SetupPlan["assessment"]["actions"][number]): string {
  if (action.kind === "create-vault-directory") return `Create vault directory ${action.path}`;
  if (action.kind === "initialize-git") return `Initialize Git at ${action.repositoryPath}`;
  if (action.kind === "ensure-scaffold-directory") return `Ensure ${action.path}`;
  if (action.kind === "write-scaffold-file") return `Create ${action.path} if missing`;
  if (action.kind === "set-content-scope") return `Configure Markdown scope in ${action.write.path}`;
  if (action.kind === "create-baseline-commit") return `Baseline ${action.paths.length} existing Markdown file(s)`;
  if (action.kind === "install-home") return `${action.disposition === "upgrade" ? "Upgrade" : "Install or resume"} packaged Dome Home`;
  if (action.kind === "select-home-vault") return "Select this vault for Dome Home";
  if (action.kind === "install-home-service") return `Install service ${action.serviceLabel} if missing`;
  return `Start service ${action.serviceLabel}`;
}

export const VAULT_KINDS = [
  "new-path",
  "empty-directory",
  "existing-non-git-vault",
  "existing-git-vault",
  "existing-dome-vault",
  "incompatible-active-operation",
  "unsafe-or-ambiguous-state",
] as const;

export const SETUP_TARGET_STATES = ["missing", "empty-directory", "existing"] as const;

export type VaultKind = typeof VAULT_KINDS[number];
export type SetupTargetState = typeof SETUP_TARGET_STATES[number];

export type SetupClassificationEvidence = Readonly<{
  targetState: SetupTargetState;
  gitState: "absent" | "clean" | "dirty" | "operation-active" | "detached" | "unborn" | "ambiguous";
  gitDirect: boolean;
  domeState: "absent" | "partial" | "configured" | "incompatible";
  blockerCodes: ReadonlyArray<string>;
  installedHomeState?: "absent" | "owned" | "foreign-owner" | "upgrade-active" | "ambiguous" | undefined;
}>;

/** The one deterministic mapping from observed setup evidence to public kind. */
export function classifySetupVault(evidence: SetupClassificationEvidence): VaultKind {
  if (evidence.gitState === "operation-active" || evidence.installedHomeState === "upgrade-active") {
    return "incompatible-active-operation";
  }
  if (evidence.blockerCodes.length > 0) return "unsafe-or-ambiguous-state";
  if (evidence.domeState === "configured" && evidence.gitDirect) return "existing-dome-vault";
  if (evidence.gitDirect) return "existing-git-vault";
  if (evidence.targetState === "missing") return "new-path";
  if (evidence.targetState === "empty-directory") return "empty-directory";
  return "existing-non-git-vault";
}

import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { createSetupPlanApplier } from "./apply";
import { compileSetupPlan, type SetupCompilerInput } from "./compiler";
import {
  SETUP_APPLY_RESULT_SCHEMA,
  SETUP_CONSENT_SCHEMA,
  type SetupApplyResult,
  type SetupConsent,
  type SetupPlan,
  validateSetupApplyResult,
  validateSetupConsent,
  validateSetupPlan,
} from "./contracts";
import { createSetupConsent, setupPlanSha256 } from "./consent";
import { canonicalSetupDiscoveryDeps } from "./defaults";
import {
  discoverSetupCompilerInput,
  type SetupDiscoveryDeps,
} from "./discovery";

export type VaultAdaptationRequest =
  | Readonly<{ mode: "preview"; targetPath: string }>
  | Readonly<{ mode: "apply"; targetPath: string; plan: SetupPlan; consentSha256: string }>
  | Readonly<{ mode: "compatibility-init"; targetPath: string }>;

export type VaultAdaptationOutcome =
  | Readonly<{
      mode: "preview";
      plan: SetupPlan;
      planSha256: string;
    }>
  | Readonly<{
      mode: "apply" | "compatibility-init";
      plan: SetupPlan;
      result: SetupApplyResult;
    }>;

export type VaultAdaptationDeps = SetupDiscoveryDeps & Readonly<{
  discover?: ((targetPath: string, deps: SetupDiscoveryDeps) => Promise<SetupCompilerInput>) | undefined;
  apply?: ((plan: SetupPlan, consent: SetupConsent) => Promise<SetupApplyResult>) | undefined;
}>;

/**
 * The one command-facing vault-adaptation Module. Both public setup and the
 * legacy init adapter enter here; discovery, compilation, consent comparison,
 * and mutation policy do not live in either CLI command.
 */
export async function adaptVault(
  request: VaultAdaptationRequest,
  deps: VaultAdaptationDeps = {},
): Promise<VaultAdaptationOutcome> {
  const requestedPath = resolve(request.targetPath);
  const targetPath = await canonicalAdaptationTarget(requestedPath);
  const discovery = canonicalSetupDiscoveryDeps(deps);
  const discover = deps.discover ?? discoverSetupCompilerInput;

  if (request.mode === "preview") {
    const plan = compileSetupPlan(await discover(targetPath, discovery));
    const digest = setupPlanSha256(plan);
    return Object.freeze({ mode: "preview", plan, planSha256: digest });
  }

  if (request.mode === "apply") {
    const plan = validateSetupPlan(request.plan);
    const consent = validateSetupConsent({
      schema: SETUP_CONSENT_SCHEMA,
      planSha256: request.consentSha256,
    });
    const planSha256 = setupPlanSha256(plan);
    if (consent.planSha256 !== planSha256) {
      return blockedOutcome(
        "apply",
        plan,
        planSha256,
        "consent-mismatch",
        "The supplied consent digest does not match the retained setup plan.",
      );
    }
    if (plan.assessment.target.path !== targetPath) {
      return blockedOutcome(
        "apply",
        plan,
        planSha256,
        "consent-mismatch",
        "The retained setup plan targets a different vault.",
      );
    }
    const apply = deps.apply ?? createSetupPlanApplier({ discovery, discover });
    const result = await apply(plan, consent);
    return Object.freeze({ mode: "apply", plan, result });
  }

  const plan = compileSetupPlan(await discover(targetPath, discovery));
  const planSha256 = setupPlanSha256(plan);
  if (!compatibleWithImplicitInitConsent(plan)) {
    return blockedOutcome(
      "compatibility-init",
      plan,
      planSha256,
      "explicit-consent-required",
      "Existing vault adaptation requires explicit preview and retained-plan consent through `dome setup`.",
    );
  }
  const consent = createSetupConsent(plan);
  const apply = deps.apply ?? createSetupPlanApplier({ discovery, discover });
  const result = await apply(plan, consent);
  return Object.freeze({ mode: request.mode, plan, result });
}

/** Freeze ancestor aliases while leaving the final leaf visible to the inspector. */
async function canonicalAdaptationTarget(targetPath: string): Promise<string> {
  const parent = dirname(targetPath);
  const canonicalParent = await realpath(parent);
  return join(canonicalParent, basename(targetPath));
}

function compatibleWithImplicitInitConsent(plan: SetupPlan): boolean {
  return plan.assessment.target.kind === "new-path" ||
    plan.assessment.target.kind === "empty-directory" ||
    (plan.assessment.target.kind === "existing-dome-vault" && plan.actions.length === 0);
}

function blockedOutcome(
  mode: "apply" | "compatibility-init",
  plan: SetupPlan,
  planSha256: string,
  code: "plan-blocked" | "explicit-consent-required" | "consent-mismatch",
  message: string,
): VaultAdaptationOutcome {
  return Object.freeze({
    mode,
    plan,
    result: validateSetupApplyResult({
      schema: SETUP_APPLY_RESULT_SCHEMA,
      status: "blocked",
      planSha256,
      recovery: { code, message, commands: plan.recoveryCommands },
    }),
  });
}

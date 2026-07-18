import { resolve } from "node:path";

import {
  renderSetupApplyResultHuman,
  renderSetupApplyResultJson,
  renderSetupPlanHuman,
  renderSetupPlanJson,
} from "../../setup/render";
import {
  adaptVault,
  type VaultAdaptationDeps,
} from "../../setup/vault-adaptation";
import { readSetupPlanFile, SetupPlanFileError } from "../../setup/plan-file";
import { EX_USAGE } from "../exit-codes";

export type RunSetupOptions = Readonly<{
  path?: string | undefined;
  dryRun?: boolean | undefined;
  apply?: boolean | undefined;
  plan?: string | undefined;
  consent?: string | undefined;
  json?: boolean | undefined;
}>;

export type RunSetupDeps = VaultAdaptationDeps;

/** Thin grammar and presentation adapter over the vault-adaptation Module. */
export async function runSetup(options: RunSetupOptions, deps: RunSetupDeps = {}): Promise<number> {
  const preview = options.dryRun === true;
  const apply = options.apply === true;
  if (preview === apply) {
    return setupUsageError(options, "choose exactly one of --dry-run or --apply");
  }
  if (preview && options.consent !== undefined) {
    return setupUsageError(options, "--consent is valid only with --apply");
  }
  if (preview && options.plan !== undefined) {
    return setupUsageError(options, "--plan is valid only with --apply");
  }
  if (apply && options.consent === undefined) {
    return setupUsageError(options, "--apply requires --consent <64-character SHA-256 digest>");
  }
  if (apply && !/^[0-9a-f]{64}$/.test(options.consent!)) {
    return setupUsageError(options, "--consent must be a lowercase 64-character SHA-256 digest");
  }
  if (apply && options.plan === undefined) {
    return setupUsageError(options, "--apply requires --plan <file> so retries retain the exact approved plan");
  }
  const targetPath = resolve(options.path ?? process.cwd());
  let retainedPlan;
  if (apply) {
    try {
      retainedPlan = await readSetupPlanFile(resolve(options.plan!));
    } catch (error) {
      const message = error instanceof SetupPlanFileError
        ? error.message
        : "the setup plan file could not be read safely";
      return setupUsageError(options, message);
    }
  }
  const outcome = await adaptVault(
    preview
      ? { mode: "preview", targetPath }
      : { mode: "apply", targetPath, plan: retainedPlan!, consentSha256: options.consent! },
    deps,
  );
  if (outcome.mode === "preview") {
    console.log(options.json === true ? renderSetupPlanJson(outcome.plan) : renderSetupPlanHuman(outcome.plan));
    return outcome.plan.status === "ready" ? 0 : 1;
  }
  console.log(
    options.json === true
      ? renderSetupApplyResultJson(outcome.result)
      : renderSetupApplyResultHuman(outcome.result),
  );
  return outcome.result.status === "completed" ? 0 : 1;
}

function setupUsageError(options: RunSetupOptions, message: string): number {
  if (options.json === true) {
    console.log(JSON.stringify({ status: "error", error: "usage", message }, null, 2));
  } else {
    console.error(`dome setup: ${message}`);
  }
  return EX_USAGE;
}

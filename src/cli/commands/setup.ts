import { resolve } from "node:path";

import { compileSetupPlan, type SetupCompilerInput } from "../../setup/compiler";
import { discoverSetupCompilerInput, type SetupDiscoveryDeps } from "../../setup/discovery";
import { renderSetupPlanHuman, renderSetupPlanJson } from "../../setup/render";
import { EX_USAGE } from "../exit-codes";
import { canonicalSetupDiscoveryDeps } from "../../setup/defaults";

export type RunSetupOptions = Readonly<{
  path?: string | undefined;
  dryRun?: boolean | undefined;
  json?: boolean | undefined;
}>;

export type RunSetupDeps = SetupDiscoveryDeps & Readonly<{
  discover?: ((targetPath: string, deps: SetupDiscoveryDeps) => Promise<SetupCompilerInput>) | undefined;
}>;

/** Thin presentation adapter over read-only discovery and the pure compiler. */
export async function runSetup(options: RunSetupOptions, deps: RunSetupDeps = {}): Promise<number> {
  if (options.dryRun !== true) return EX_USAGE;
  const targetPath = resolve(options.path ?? process.cwd());
  const discoveryDeps = canonicalSetupDiscoveryDeps(deps);
  const evidence = await (deps.discover ?? discoverSetupCompilerInput)(targetPath, discoveryDeps);
  const plan = compileSetupPlan(evidence);
  console.log(options.json === true ? renderSetupPlanJson(plan) : renderSetupPlanHuman(plan));
  return plan.status === "ready" ? 0 : 1;
}

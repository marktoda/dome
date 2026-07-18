import { resolve } from "node:path";

import { DEFAULT_AGENTS_MD, DEFAULT_GITIGNORE } from "./init-templates";
import { defaultConfigYaml } from "../default-vault-config";
import { compileSetupPlan, type SetupCompilerInput } from "../../setup/compiler";
import { discoverSetupCompilerInput, type SetupDiscoveryDeps } from "../../setup/discovery";
import { renderSetupPlanHuman, renderSetupPlanJson } from "../../setup/render";
import { DEFAULT_SETUP_CONTENT_SCOPE, renderSetupContentScopeConfig } from "../../setup/scaffold";
import { EX_USAGE } from "../exit-codes";

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
  const discoveryDeps = withSetupDefaults(deps);
  const evidence = await (deps.discover ?? discoverSetupCompilerInput)(targetPath, discoveryDeps);
  const plan = compileSetupPlan(evidence);
  console.log(options.json === true ? renderSetupPlanJson(plan) : renderSetupPlanHuman(plan));
  return plan.status === "ready" ? 0 : 1;
}

function withSetupDefaults(deps: RunSetupDeps): SetupDiscoveryDeps {
  const contentScope = deps.contentScope ?? DEFAULT_SETUP_CONTENT_SCOPE;
  return {
    ...deps,
    contentScope,
    scaffold: deps.scaffold ?? {
      agentsOrientation: DEFAULT_AGENTS_MD,
      gitignore: DEFAULT_GITIGNORE,
      vaultConfig: defaultConfigYaml({ contentScope }),
      contentScopeConfig: renderSetupContentScopeConfig(contentScope),
    },
  };
}

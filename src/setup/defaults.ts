import { defaultConfigYaml } from "../cli/default-vault-config";
import { DEFAULT_AGENTS_MD, DEFAULT_GITIGNORE } from "../cli/commands/init-templates";
import type { SetupDiscoveryDeps } from "./discovery";
import { DEFAULT_SETUP_CONTENT_SCOPE, renderSetupContentScopeConfig } from "./scaffold";

/** One canonical source of the bytes previewed and later applied by setup. */
export function canonicalSetupDiscoveryDeps(
  overrides: SetupDiscoveryDeps = {},
): SetupDiscoveryDeps {
  const contentScope = overrides.contentScope ?? DEFAULT_SETUP_CONTENT_SCOPE;
  return {
    ...overrides,
    contentScope,
    scaffold: overrides.scaffold ?? {
      agentsOrientation: DEFAULT_AGENTS_MD,
      gitignore: DEFAULT_GITIGNORE,
      vaultConfig: defaultConfigYaml({ contentScope }),
      contentScopeConfig: renderSetupContentScopeConfig(contentScope),
    },
  };
}

import { initRepo } from "../../src/git";
import { scaffoldVaultLayout } from "../../src/vault-scaffold";
import { makeTempDir, removeTempDir } from "./temp-dir";

export interface TestVault {
  path: string;
  cleanup: () => Promise<void>;
}

export interface MakeTestVaultOpts {
  initGit?: boolean;
  initDome?: boolean;
  /** Override `.dome/config.yaml` contents — defaults to the shipped config. */
  config?: string;
  /** Override `.dome/page-types.yaml` contents — defaults to the shipped catalog. */
  pageTypes?: string;
}

/**
 * Build a temp vault for unit tests. Directory tree and shipped defaults
 * come from `scaffoldVaultLayout` (single source of truth — see
 * `src/shipped-defaults.ts`). `initDome=false` skips the .dome scaffold for
 * tests that exercise pre-init states (e.g., dome-init).
 */
export async function makeTestVault(opts: MakeTestVaultOpts = {}): Promise<TestVault> {
  const { initGit = true, initDome = true, config, pageTypes } = opts;
  const path = await makeTempDir();

  if (initDome) {
    await scaffoldVaultLayout(path, {
      ...(config !== undefined ? { configOverride: config } : {}),
      ...(pageTypes !== undefined ? { pageTypesOverride: pageTypes } : {}),
      writeGitignore: false,
    });
  }

  if (initGit) {
    await initRepo(path);
  }

  return {
    path,
    cleanup: () => removeTempDir(path),
  };
}

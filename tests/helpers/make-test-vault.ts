import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepo, commit } from "../../src/git";
import { scaffoldVaultLayout } from "../../src/vault-scaffold";
import { buildInitialAgentsMd } from "../../src/agents-md";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "../../src/shipped-defaults";
import { WORKFLOW_NAMES } from "../../src/workflows/workflow-name";
import { makeTempDir, removeTempDir } from "./temp-dir";

export interface TestVault {
  path: string;
  cleanup: () => Promise<void>;
}

export interface MakeTestVaultOpts {
  initGit?: boolean;
  initDome?: boolean;
  /**
   * Make an initial commit after scaffolding, matching what real `dome init`
   * does. Defaults to true. Set to false for tests that exercise pre-commit
   * states (e.g., empty-vault edge cases). Has no effect when `initGit ===
   * false` or `initDome === false`.
   */
  initialCommit?: boolean;
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
 *
 * By default makes an initial commit so the resulting vault matches what
 * `dome init` produces (and what `sync` / `getAdoptionStatus` need: a HEAD
 * to point the adopted ref at). Set `initialCommit: false` to skip the
 * commit for tests that exercise the empty-vault edge case.
 */
export async function makeTestVault(opts: MakeTestVaultOpts = {}): Promise<TestVault> {
  const { initGit = true, initDome = true, initialCommit = true, config, pageTypes } = opts;
  const path = await makeTempDir();

  if (initDome) {
    await scaffoldVaultLayout(path, {
      ...(config !== undefined ? { configOverride: config } : {}),
      ...(pageTypes !== undefined ? { pageTypesOverride: pageTypes } : {}),
      writeGitignore: false,
    });
    // AGENTS_MD_IS_ORIENTATION_SURFACE: doctor flags these as missing.
    // Mirror dome init so test vaults pass the drift check by default.
    await writeFile(
      join(path, "AGENTS.md"),
      buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, [...WORKFLOW_NAMES]),
    );
    await writeFile(join(path, "CLAUDE.md"), "See AGENTS.md.\n");
  }

  if (initGit) {
    await initRepo(path);
    if (initialCommit && initDome) {
      // Mirror `dome init`'s initial commit so `sync`, `getAdoptionStatus`,
      // and any callers that rely on HEAD existing work without per-test
      // setup. `git add` is tolerant of missing entries, so listing optional
      // files (e.g., intake-raw.yaml in fixtures that disabled it) won't
      // break the commit.
      await commit({
        path,
        message: "chore: initialize Dome vault for test\n",
        files: [
          ".dome/config.yaml",
          ".dome/page-types.yaml",
          ".dome/hooks/intake-raw.yaml",
          "AGENTS.md",
          "CLAUDE.md",
          "index.md",
          "log.md",
        ],
      });
    }
  }

  return {
    path,
    cleanup: () => removeTempDir(path),
  };
}

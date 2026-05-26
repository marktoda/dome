import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { initRepo } from "../git";
import { scaffoldVaultLayout } from "../vault-scaffold";
import { makeTempDir } from "../../tests/helpers/temp-dir";

export interface Fixture {
  files: Record<string, string>;
  /** Override `.dome/config.yaml` contents — defaults to the shipped config. */
  config?: string;
}

export interface EvalFixtureVault {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a git-backed temp vault for eval / integration tests. The directory
 * tree and shipped defaults come from `scaffoldVaultLayout` (single source of
 * truth — see `src/shipped-defaults.ts`); this factory only layers on the
 * fixture's test files and the empty index/log placeholders eval tests
 * historically expect (no bootstrap log entry).
 */
export async function makeFixtureVault(fx: Fixture): Promise<EvalFixtureVault> {
  const path = await makeTempDir("dome-eval-");
  await scaffoldVaultLayout(path, {
    ...(fx.config !== undefined ? { configOverride: fx.config } : {}),
    writeIndexAndLog: false,
    writeGitignore: false,
  });
  await writeFile(join(path, "index.md"), "# Index\n\n");
  await writeFile(join(path, "log.md"), "# Log\n\n");
  for (const [rel, body] of Object.entries(fx.files)) {
    const abs = join(path, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  await initRepo(path);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    },
  };
}

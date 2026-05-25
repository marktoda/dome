import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { makeTempDir, removeTempDir } from "./temp-dir";

export interface TestVault {
  path: string;
  cleanup: () => Promise<void>;
}

export interface MakeTestVaultOpts {
  initGit?: boolean;
  initDome?: boolean;
  config?: string;
  pageTypes?: string;
}

const DEFAULT_CONFIG = `# Dome vault config
invariants:
  EVERY_WRITE_IS_LOGGED: enabled
  PAGE_TYPE_BY_DIRECTORY: enabled
  WIKILINKS_ARE_FULLPATH: enabled
  INBOX_IS_EPHEMERAL: enabled
  SENSITIVE_GOES_TO_INBOX: disabled
  PAGE_CREATION_REQUIRES_RECURRENCE: disabled
hooks:
  builtin:
    auto-update-index: enabled
    auto-cross-reference: enabled
  max_causation_depth: 50
git:
  auto_commit_workflows: true
`;

const DEFAULT_PAGE_TYPES = `defaults:
  - entity
  - concept
  - source
  - synthesis
extensions: []
`;

export async function makeTestVault(opts: MakeTestVaultOpts = {}): Promise<TestVault> {
  const { initGit = true, initDome = true, config = DEFAULT_CONFIG, pageTypes = DEFAULT_PAGE_TYPES } = opts;
  const path = await makeTempDir();

  if (initDome) {
    await mkdir(join(path, ".dome"), { recursive: true });
    await mkdir(join(path, ".dome", "state"), { recursive: true });
    await mkdir(join(path, "wiki", "entities"), { recursive: true });
    await mkdir(join(path, "wiki", "concepts"), { recursive: true });
    await mkdir(join(path, "wiki", "sources"), { recursive: true });
    await mkdir(join(path, "wiki", "syntheses"), { recursive: true });
    await mkdir(join(path, "raw"), { recursive: true });
    await mkdir(join(path, "notes"), { recursive: true });
    await mkdir(join(path, "inbox", "raw"), { recursive: true });
    await writeFile(join(path, ".dome", "config.yaml"), config);
    await writeFile(join(path, ".dome", "page-types.yaml"), pageTypes);
    await writeFile(join(path, "index.md"), "# Index\n\n");
    await writeFile(join(path, "log.md"), "# Log\n\n");
  }

  if (initGit) {
    await git.init({ fs, dir: path, defaultBranch: "main" });
  }

  return {
    path,
    cleanup: () => removeTempDir(path),
  };
}

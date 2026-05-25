import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { makeTempDir } from "../../tests/helpers/temp-dir";

export interface Fixture {
  files: Record<string, string>;
  config?: string;
}

export interface EvalFixtureVault {
  path: string;
  cleanup: () => Promise<void>;
}

const DEFAULT_CONFIG = `invariants:
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

const DEFAULT_PAGE_TYPES = `defaults: [entity, concept, source, synthesis]
extensions: []
`;

export async function makeFixtureVault(fx: Fixture): Promise<EvalFixtureVault> {
  const path = await makeTempDir("dome-eval-");
  await mkdir(join(path, ".dome", "state"), { recursive: true });
  await mkdir(join(path, "wiki", "entities"), { recursive: true });
  await mkdir(join(path, "wiki", "concepts"), { recursive: true });
  await mkdir(join(path, "wiki", "sources"), { recursive: true });
  await mkdir(join(path, "wiki", "syntheses"), { recursive: true });
  await mkdir(join(path, "raw"), { recursive: true });
  await mkdir(join(path, "notes"), { recursive: true });
  await mkdir(join(path, "inbox", "raw"), { recursive: true });
  await writeFile(join(path, ".dome", "config.yaml"), fx.config ?? DEFAULT_CONFIG);
  await writeFile(join(path, ".dome", "page-types.yaml"), DEFAULT_PAGE_TYPES);
  await writeFile(join(path, "index.md"), "# Index\n\n");
  await writeFile(join(path, "log.md"), "# Log\n\n");
  for (const [rel, body] of Object.entries(fx.files)) {
    const abs = join(path, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body);
  }
  await git.init({ fs, dir: path, defaultBranch: "main" });
  return {
    path,
    cleanup: async () => {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    },
  };
}

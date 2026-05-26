import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { ok, err, type Result, type ToolError } from "../../types";

const SHIPPED_CONFIG_YAML = `# Dome vault config
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

const SHIPPED_PAGE_TYPES_YAML = `defaults:
  - entity
  - concept
  - source
  - synthesis
extensions: []
`;

const SHIPPED_GITIGNORE = `.dome/state/
node_modules/
.DS_Store
`;

const INTAKE_RAW_HOOK_YAML = `# Shipped-default intake hook
event: document.written
path_pattern: "inbox/raw/*"
workflow: ingest
async: true
idempotent: true
`;

const SHIPPED_CLAUDE_MD = `# Claude Code config for this Dome vault

Add to your Claude Code MCP config:

\`\`\`json
{
  "mcpServers": {
    "dome": {
      "command": "bun",
      "args": ["x", "@dome/sdk", "serve", "--vault", "$VAULT_PATH"]
    }
  }
}
\`\`\`

System prompt: see .dome/prompts/ or the SDK builtin system-base.md.
`;

export async function domeInit(vaultPath: string): Promise<Result<{ path: string; sha: string }, ToolError>> {
  if (existsSync(join(vaultPath, ".dome"))) {
    return err({ kind: "already-exists", path: vaultPath });
  }
  if (existsSync(join(vaultPath, ".git"))) {
    return err({ kind: "validation", message: `Existing .git at ${vaultPath}; use dome migrate instead` });
  }

  await mkdir(vaultPath, { recursive: true });
  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });
  await mkdir(join(vaultPath, ".dome", "prompts"), { recursive: true });
  await mkdir(join(vaultPath, ".dome", "hooks"), { recursive: true });
  await mkdir(join(vaultPath, "wiki", "entities"), { recursive: true });
  await mkdir(join(vaultPath, "wiki", "concepts"), { recursive: true });
  await mkdir(join(vaultPath, "wiki", "sources"), { recursive: true });
  await mkdir(join(vaultPath, "wiki", "syntheses"), { recursive: true });
  await mkdir(join(vaultPath, "raw"), { recursive: true });
  await mkdir(join(vaultPath, "notes"), { recursive: true });
  await mkdir(join(vaultPath, "inbox", "raw"), { recursive: true });

  await writeFile(join(vaultPath, ".dome", "config.yaml"), SHIPPED_CONFIG_YAML);
  await writeFile(join(vaultPath, ".dome", "page-types.yaml"), SHIPPED_PAGE_TYPES_YAML);
  await writeFile(join(vaultPath, ".dome", "hooks", "intake-raw.yaml"), INTAKE_RAW_HOOK_YAML);
  await writeFile(join(vaultPath, ".gitignore"), SHIPPED_GITIGNORE);
  await writeFile(join(vaultPath, "index.md"), "# Index\n\nThe catalog of wiki pages in this vault.\n");
  await writeFile(join(vaultPath, "log.md"), `# Log\n\n## [${new Date().toISOString()}] bootstrap | initialize Dome vault\n`);
  await writeFile(join(vaultPath, "CLAUDE.md"), SHIPPED_CLAUDE_MD);

  await git.init({ fs, dir: vaultPath, defaultBranch: "main" });
  // Add and commit
  const filesToCommit = [
    ".gitignore", "index.md", "log.md", "CLAUDE.md",
    ".dome/config.yaml", ".dome/page-types.yaml", ".dome/hooks/intake-raw.yaml",
  ];
  for (const f of filesToCommit) {
    await git.add({ fs, dir: vaultPath, filepath: f });
  }
  const sha = await git.commit({
    fs, dir: vaultPath,
    message: "chore: initialize Dome vault",
    author: { name: "Dome", email: "dome@local" },
  });
  return ok({ path: vaultPath, sha });
}

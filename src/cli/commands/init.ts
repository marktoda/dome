import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepo, commit } from "../../git";
import { scaffoldVaultLayout } from "../../vault-scaffold";
import { ok, err, type Result, type ToolError } from "../../types";

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

  // Scaffold the canonical vault layout (dir tree + shipped config). Returns
  // the list of files actually written so we know what to commit.
  const scaffolded = await scaffoldVaultLayout(vaultPath);

  // Init-specific extras: the shipped-default intake hook, the Claude Code
  // setup hint. Migrate does NOT write these — the migrate workflow may add
  // them later, and an existing vault might have its own equivalents.
  const intakeRel = ".dome/hooks/intake-raw.yaml";
  const claudeRel = "CLAUDE.md";
  await writeFile(join(vaultPath, intakeRel), INTAKE_RAW_HOOK_YAML);
  await writeFile(join(vaultPath, claudeRel), SHIPPED_CLAUDE_MD);

  await initRepo(vaultPath);
  const sha = await commit({
    path: vaultPath,
    message: "chore: initialize Dome vault",
    files: [...scaffolded, intakeRel, claudeRel],
  });
  return ok({ path: vaultPath, sha });
}

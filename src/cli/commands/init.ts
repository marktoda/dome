import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initRepo, commit } from "../../git";
import { scaffoldVaultLayout } from "../../vault-scaffold";
import { buildInitialAgentsMd } from "../../agents-md";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "../../shipped-defaults";
import { WORKFLOW_NAMES } from "../../workflows/workflow-name";
import { ok, err, type Result, type ToolError } from "../../types";

const INTAKE_RAW_HOOK_YAML = `# Shipped-default intake hook
event: document.written
path_pattern: "inbox/raw/*"
workflow: ingest
async: true
idempotent: true
`;

// CLAUDE.md exists only as a harness shim. Claude Code's auto-load convention
// currently prefers CLAUDE.md; this points at AGENTS.md so all content lives
// in one place. Remove once AGENTS.md auto-load is universal across harnesses.
const SHIPPED_CLAUDE_MD_SHIM = `See AGENTS.md.\n`;

export async function domeInit(vaultPath: string): Promise<Result<{ path: string; sha: string }, ToolError>> {
  if (existsSync(join(vaultPath, ".dome"))) {
    return err({ kind: "already-exists", path: vaultPath });
  }
  if (existsSync(join(vaultPath, ".git"))) {
    return err({ kind: "validation", message: `Existing .git at ${vaultPath}; use dome migrate instead` });
  }

  const scaffolded = await scaffoldVaultLayout(vaultPath);

  const intakeRel = ".dome/hooks/intake-raw.yaml";
  const agentsRel = "AGENTS.md";
  const claudeRel = "CLAUDE.md";
  await writeFile(join(vaultPath, intakeRel), INTAKE_RAW_HOOK_YAML);
  await writeFile(
    join(vaultPath, agentsRel),
    buildInitialAgentsMd(SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES, [...WORKFLOW_NAMES]),
  );
  await writeFile(join(vaultPath, claudeRel), SHIPPED_CLAUDE_MD_SHIM);

  await initRepo(vaultPath);
  const sha = await commit({
    path: vaultPath,
    message: "chore: initialize Dome vault",
    files: [...scaffolded, intakeRel, agentsRel, claudeRel],
  });
  return ok({ path: vaultPath, sha });
}

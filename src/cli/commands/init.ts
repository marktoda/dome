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

// AGENTS.md is the vault-owned per-vault file: cross-harness convention,
// user-tendable, never clobbered by SDK updates after init. System rules
// deliberately live OFF this file — the MCP server delivers them as
// `instructions` at mount time. The HTML-comment block delimits the user-
// editable section so future `dome doctor --repair` runs can re-template
// scaffolding without touching user prose.
const SHIPPED_AGENTS_MD = `# This vault

A Dome vault. Operate it through the dome MCP server — it carries the universal
rules, the current invariant flags, and the tool surface. Mount with:

    bun x @dome/sdk serve --vault .

## Cold-start without MCP

If MCP isn't mounted yet, the bare minimum you need:
- \`.dome/config.yaml\` — which invariants are enabled in this vault
- \`.dome/page-types.yaml\` — page types beyond the four shipped defaults
- Never write to \`raw/\`. Never mutate \`log.md\` or \`index.md\` directly.
- Mount the MCP server before doing anything else; the full rule set lives there.

## Vault notes

<!-- Tend this section over time. Examples of what belongs here:
     - Projects this vault tracks
     - Personal naming conventions
     - Directories with special meaning beyond Dome's defaults
     - People/entities the agent should know exist
-->
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

  // Scaffold the canonical vault layout (dir tree + shipped config). Returns
  // the list of files actually written so we know what to commit.
  const scaffolded = await scaffoldVaultLayout(vaultPath);

  // Init-specific extras: the shipped-default intake hook, AGENTS.md (vault-
  // owned cold-start file), and a CLAUDE.md shim pointing at AGENTS.md.
  // Migrate does NOT write these — an existing vault may have its own.
  const intakeRel = ".dome/hooks/intake-raw.yaml";
  const agentsRel = "AGENTS.md";
  const claudeRel = "CLAUDE.md";
  await writeFile(join(vaultPath, intakeRel), INTAKE_RAW_HOOK_YAML);
  await writeFile(join(vaultPath, agentsRel), SHIPPED_AGENTS_MD);
  await writeFile(join(vaultPath, claudeRel), SHIPPED_CLAUDE_MD_SHIM);

  await initRepo(vaultPath);
  const sha = await commit({
    path: vaultPath,
    message: "chore: initialize Dome vault",
    files: [...scaffolded, intakeRel, agentsRel, claudeRel],
  });
  return ok({ path: vaultPath, sha });
}

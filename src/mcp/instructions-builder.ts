import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "../vault";
import { PromptLoader } from "../prompts/prompt-loader";

// Assembles the MCP server's `instructions` string — the rich, per-vault
// orientation every connecting client receives on `initialize`. Layering:
//   - system-base.md: universal Dome rules (loaded via PromptLoader so it
//     is bit-identical to the workflow-time `{{include}}` path and honors
//     vault-local overrides under .dome/prompts/).
//   - .dome/config.yaml enabled invariants: per-vault flag digest.
//   - .dome/page-types.yaml defaults + extensions: per-vault page-type set.
//   - AGENTS.md: per-vault user-tended notes (graceful fallback when absent).
export async function buildInstructions(vault: Vault): Promise<string> {
  const loader = new PromptLoader(vault);
  const systemBase = await loader.load("system-base");
  const systemBaseBody = systemBase?.body ?? "";

  const enabledInvariants = Object.entries(vault.config.invariants)
    .filter(([, v]) => v === "enabled")
    .map(([k]) => `- ${k}`)
    .join("\n");

  const pageTypes = [
    ...vault.pageTypes.defaults,
    ...vault.pageTypes.extensions.map((e) => (typeof e === "string" ? e : e.name)),
  ]
    .map((t) => `- ${t}`)
    .join("\n");

  const agentsPath = join(vault.path, "AGENTS.md");
  const vaultNotes = existsSync(agentsPath)
    ? await readFile(agentsPath, "utf8")
    : "_No AGENTS.md present._";

  return [
    systemBaseBody,
    "",
    "## This vault",
    "",
    "### Enabled invariants",
    enabledInvariants || "_(none enabled)_",
    "",
    "### Page types",
    pageTypes,
    "",
    "### Vault notes (from AGENTS.md)",
    vaultNotes,
  ].join("\n");
}

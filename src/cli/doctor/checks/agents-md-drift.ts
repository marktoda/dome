// AGENTS_MD_IS_ORIENTATION_SURFACE drift check.
//
// CHECK 10:
//   - AGENTS.md must exist, carry user-prose delimiters, AND its templated
//     section must match what we'd generate from the current config.
//   - CLAUDE.md must exist AND its content must be `See AGENTS.md.` (trimmed).
//
// The drift checks close the "templated sections out of sync with current
// config → violation" claim in the invariant doc.

import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Vault } from "../../../vault";
import { WORKFLOW_NAMES } from "../../../workflows/workflow-name";
import type { CheckResult } from "./types";

export async function checkAgentsMdDrift(vault: Vault): Promise<CheckResult> {
  const violations: string[] = [];
  const info: string[] = [];

  const agentsAbs = join(vault.path, "AGENTS.md");
  const claudeAbs = join(vault.path, "CLAUDE.md");
  if (!existsSync(agentsAbs)) {
    violations.push(
      "AGENTS.md: missing at vault root (AGENTS_MD_IS_ORIENTATION_SURFACE — run `dome doctor --repair`)",
    );
  } else {
    const agentsBody = await Bun.file(agentsAbs).text();
    const { buildAgentsMdTemplated, USER_PROSE_BEGIN, USER_PROSE_END } = await import("../../../agents-md");
    if (!agentsBody.includes(USER_PROSE_BEGIN) || !agentsBody.includes(USER_PROSE_END)) {
      violations.push(
        "AGENTS.md: user-prose delimiters missing (`dome doctor --repair` regenerates them)",
      );
    } else {
      const beginIdx = agentsBody.indexOf(USER_PROSE_BEGIN);
      const existingTemplated = agentsBody.slice(0, beginIdx).replace(/\n+$/, "");
      const expectedTemplated = buildAgentsMdTemplated(
        vault.config,
        vault.pageTypes,
        [...WORKFLOW_NAMES],
      ).replace(/\n+$/, "");
      if (existingTemplated !== expectedTemplated) {
        violations.push(
          "AGENTS.md: templated section out of sync with current config (`dome doctor --repair` regenerates it)",
        );
      }
    }
  }
  if (!existsSync(claudeAbs)) {
    violations.push(
      `CLAUDE.md: shim missing at vault root (Claude Code auto-loads this; should contain "See AGENTS.md.")`,
    );
  } else {
    const claudeBody = await Bun.file(claudeAbs).text();
    if (claudeBody.trim() !== "See AGENTS.md.") {
      violations.push(
        `CLAUDE.md: content drift (expected "See AGENTS.md.", found different content; \`dome doctor --repair\` restores the canonical shim)`,
      );
    }
  }

  return { violations, info };
}

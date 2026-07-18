// Lockstep marker for invariant AGENTS_MD_IS_ORIENTATION_SURFACE.
//
// The substrate spec at docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md
// describes the rule; the structural enforcement lives in the v1
// engine + storage layer code under src/{core,engine,processors,
// ledger,projections,outbox}/ and the tests under the matching
// tests/ directories.
//
// This file exists as the AC3-lockstep indirection: adding or removing
// the invariant doc requires explicit substrate work (touching this
// file). The check is structural — the doc is real because the file
// exists; the file is real because the invariant is documented.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const INVARIANT_DOC = join(REPO_ROOT, "docs", "wiki", "invariants", "AGENTS_MD_IS_ORIENTATION_SURFACE.md");
const SETUP_DEFAULTS = join(REPO_ROOT, "src", "setup", "defaults.ts");
const ORIENTATION_TEMPLATES = join(REPO_ROOT, "src", "cli", "commands", "init-templates.ts");
const USER_PROSE_BEGIN = "<!-- BEGIN user-prose -->";
const USER_PROSE_END = "<!-- END user-prose -->";

describe("AGENTS_MD_IS_ORIENTATION_SURFACE lockstep", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });

  test("user-prose delimiters live in the canonical create-only setup scaffold", () => {
    const doc = readFileSync(INVARIANT_DOC, "utf8");
    const defaults = readFileSync(SETUP_DEFAULTS, "utf8");
    const templates = readFileSync(ORIENTATION_TEMPLATES, "utf8");

    expect(doc).toContain(USER_PROSE_BEGIN);
    expect(doc).toContain(USER_PROSE_END);
    expect(defaults).toContain("DEFAULT_AGENTS_MD");
    expect(defaults).toContain("CLAUDE_MD_TEMPLATE");
    expect(templates).toContain("@AGENTS.md");
    expect(defaults).not.toContain("writeFile");
  });
});

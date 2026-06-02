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
const INIT_COMMAND = join(REPO_ROOT, "src", "cli", "commands", "init.ts");
const USER_PROSE_BEGIN = "<!-- BEGIN user-prose -->";
const USER_PROSE_END = "<!-- END user-prose -->";

describe("AGENTS_MD_IS_ORIENTATION_SURFACE lockstep", () => {
  test("invariant doc exists at the canonical path", () => {
    expect(existsSync(INVARIANT_DOC)).toBe(true);
  });

  test("user-prose delimiters match the init refresh implementation", () => {
    const doc = readFileSync(INVARIANT_DOC, "utf8");
    const init = readFileSync(INIT_COMMAND, "utf8");
    const begin = init.match(/const USER_PROSE_BEGIN = "([^"]+)";/)?.[1];
    const end = init.match(/const USER_PROSE_END = "([^"]+)";/)?.[1];

    expect(doc).toContain(USER_PROSE_BEGIN);
    expect(doc).toContain(USER_PROSE_END);
    expect(begin).toBe(USER_PROSE_BEGIN);
    expect(end).toBe(USER_PROSE_END);
  });
});

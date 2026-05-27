// Smoke tests for src/engine/closure-commit.ts: the two `null`-return paths
// in Phase 2 (empty touched paths; auto_commit_workflows disabled). The
// actual commit-creation path is exercised end-to-end in Phase 3+ vault tests.

import { describe, test, expect } from "bun:test";
import { makeClosureCommit } from "../../src/engine/closure-commit";
import type { EngineVault } from "../../src/engine/vault-shape";
import { commitOid } from "../../src/core/source-ref";

// Minimal `EngineVault` — `makeClosureCommit` only reads
// `vault.config.git.auto_commit_workflows` and `vault.path` on the
// null-path branches. The two-field shape is exactly what the engine
// names, so no cast is needed.
const mockVault = (autoCommit: boolean): EngineVault => ({
  path: "/tmp/fake-vault",
  config: {
    git: { auto_commit_workflows: autoCommit },
  },
});

describe("makeClosureCommit null-return paths", () => {
  test("returns null when touchedPaths is empty", async () => {
    const result = await makeClosureCommit({
      vault: mockVault(true),
      base: commitOid("abc"),
      sourceHead: commitOid("def"),
      touchedPaths: [],
      proposalId: "prop_1_aaaaaa",
    });
    expect(result).toBeNull();
  });

  test("returns null when auto_commit_workflows is false", async () => {
    const result = await makeClosureCommit({
      vault: mockVault(false),
      base: commitOid("abc"),
      sourceHead: commitOid("def"),
      touchedPaths: ["wiki/x.md"],
      proposalId: "prop_1_aaaaaa",
    });
    expect(result).toBeNull();
  });
});

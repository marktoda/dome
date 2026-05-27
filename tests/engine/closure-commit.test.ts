// Smoke tests for src/engine/closure-commit.ts: the two `null`-return paths
// in Phase 2 (empty touched paths; auto_commit_workflows disabled). The
// actual commit-creation path is exercised end-to-end in Phase 3+ vault tests.

import { describe, test, expect } from "bun:test";
import { makeClosureCommit } from "../../src/engine/closure-commit";
import { commitOid } from "../../src/core/source-ref";
import type { Vault } from "../../src/vault";

// Minimal structural mock — makeClosureCommit only reads
// `vault.config.git.auto_commit_workflows` and `vault.path` on the null-path
// branches. Cast through `unknown` so we don't need a full Vault build.
const mockVault = (autoCommit: boolean): Vault =>
  ({
    path: "/tmp/fake-vault",
    config: {
      invariants: {},
      hooks: { builtin: {}, max_causation_depth: 0, inbox_stale_age_hours: 0 },
      git: { auto_commit_workflows: autoCommit },
    },
  } as unknown as Vault);

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

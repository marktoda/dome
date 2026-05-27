import { describe, test, expect } from "bun:test";
import { commitWorkflow } from "../src/workflow-commit";
import { openVault } from "../src/vault";
import { makeTestVault } from "./helpers/make-test-vault";
import { log as gitLog } from "../src/git";
import { makeRunContext, ZERO_SHA } from "../src/adoption";

describe("commitWorkflow", () => {
  test("creates a single commit with all paths touched + log entry subject", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      const sha = await commitWorkflow(vault, {
        verb: "ingest",
        subject: "create Danny entity page",
        body: "Initial ingest from voice note",
        touchedPaths: ["wiki/entities/danny.md", "log.md", "index.md"],
        runContext: makeRunContext({ extensionId: "ingest", base: ZERO_SHA, sourceHead: ZERO_SHA }),
      });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      // Verify subject in git log
      const log = await gitLog({ path: v.path, ref: "HEAD", depth: 1 });
      expect(log[0]!.commit.message).toContain("create Danny entity page");
    } finally {
      await v.cleanup();
    }
  });

  test("refuses (throws) when runContext is absent — structural fence for ENGINE_COMMITS_CARRY_DOME_TRAILERS", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      // Casting to bypass TypeScript's required-property check; the runtime
      // throw is the structural fence a JavaScript caller (or a future
      // refactor that drops the type-system guarantee) would hit. Per
      // docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md
      // §"Structural enforcement".
      const promise = commitWorkflow(vault, {
        verb: "ingest",
        subject: "should refuse",
        touchedPaths: ["log.md"],
      } as unknown as Parameters<typeof commitWorkflow>[1]);
      await expect(promise).rejects.toThrow(/runContext/);
    } finally {
      await v.cleanup();
    }
  });

  test("returns empty string when auto_commit_workflows is disabled", async () => {
    const v = await makeTestVault({
      config: `invariants: {}
hooks:
  builtin: {}
  max_causation_depth: 50
git:
  auto_commit_workflows: false
`,
    });
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      const sha = await commitWorkflow(vault, {
        verb: "ingest",
        subject: "no-op",
        touchedPaths: ["log.md"],
        runContext: makeRunContext({ extensionId: "ingest", base: ZERO_SHA, sourceHead: ZERO_SHA }),
      });
      expect(sha).toBe("");
    } finally {
      await v.cleanup();
    }
  });
});

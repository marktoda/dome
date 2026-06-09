// dome.markdown.core-size — the core-memory size budget lint. Deterministic
// warning when the literal vault-root `core.md` exceeds ~6,000 characters
// (core memory must stay small enough to load everywhere). A custom
// dome.agent core_path forgoes this lint by design — dome.markdown does not
// read dome.agent's config.

import { describe, expect, test } from "bun:test";

import coreSize, {
  CORE_SIZE_BUDGET_CHARS,
} from "../../assets/extensions/dome.markdown/processors/core-size";
import type { DiagnosticEffect } from "../../src/core/effect";
import { commitOid } from "../../src/core/source-ref";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

describe("dome.markdown.core-size", () => {
  test("core.md over the budget → one warning with the split-into-wiki hint", async () => {
    const effects = await runCoreSize({
      files: { "core.md": "x".repeat(CORE_SIZE_BUDGET_CHARS + 1) },
      changedPaths: ["core.md"],
    });
    expect(effects.length).toBe(1);
    const diag = effects[0] as DiagnosticEffect;
    expect(diag.kind).toBe("diagnostic");
    expect(diag.severity).toBe("warning");
    expect(diag.code).toBe("dome.markdown.core-oversize");
    expect(diag.message).toContain(`${CORE_SIZE_BUDGET_CHARS + 1} characters`);
    expect(diag.message).toContain(
      "core memory must stay small enough to load everywhere",
    );
    expect(diag.message).toContain("split details into wiki pages");
    expect(diag.sourceRefs.map((r) => r.path)).toEqual(["core.md"]);
  });

  test("core.md exactly at the budget is quiet (boundary)", async () => {
    const effects = await runCoreSize({
      files: { "core.md": "x".repeat(CORE_SIZE_BUDGET_CHARS) },
      changedPaths: ["core.md"],
    });
    expect(effects.length).toBe(0);
  });

  test("a small core.md is quiet", async () => {
    const effects = await runCoreSize({
      files: { "core.md": "# Core memory\n\n## Who I am\nMark.\n" },
      changedPaths: ["core.md"],
    });
    expect(effects.length).toBe(0);
  });

  test("only the literal core.md path fires — a custom core_path forgoes the lint", async () => {
    const effects = await runCoreSize({
      files: {
        "notes/core.md": "x".repeat(CORE_SIZE_BUDGET_CHARS * 2),
        "wiki/concepts/core.md": "x".repeat(CORE_SIZE_BUDGET_CHARS * 2),
      },
      changedPaths: ["notes/core.md", "wiki/concepts/core.md"],
    });
    expect(effects.length).toBe(0);
  });

  test("no-op when core.md did not change in this run", async () => {
    const effects = await runCoreSize({
      files: { "core.md": "x".repeat(CORE_SIZE_BUDGET_CHARS * 2) },
      changedPaths: ["wiki/concepts/other.md"],
    });
    expect(effects.length).toBe(0);
  });

  test("no-op when core.md changed but is absent from the snapshot (deleted)", async () => {
    const effects = await runCoreSize({
      files: {},
      changedPaths: ["core.md"],
    });
    expect(effects.length).toBe(0);
  });
});

async function runCoreSize(opts: {
  readonly files: Record<string, string>;
  readonly changedPaths: ReadonlyArray<string>;
}) {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(opts.files),
    changedPaths: opts.changedPaths,
    proposal: null,
    runId: "run-core-size",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] } as unknown,
  });
  return coreSize.run(ctx);
}

function fakeSnapshot(files: Record<string, string>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async (p: string) => files[p] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
}

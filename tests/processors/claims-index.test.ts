import { describe, expect, test } from "bun:test";

import { claimFactValue } from "../../assets/extensions/dome.claims/processors/claim-fact";
import claimIndex from "../../assets/extensions/dome.claims/processors/claim-index";
import type { DiagnosticEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD = commitOid("4444444444444444444444444444444444444444");
const TREE = treeOid("5555555555555555555555555555555555555555");

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((p) => p.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD,
            lastChangedAt: "2026-07-02T09:00:00.000Z",
            lastHumanChangedAt: "2026-07-02T09:00:00.000Z",
          },
  });
}

async function runIndex(
  path: string,
  content: string,
): Promise<ReadonlyArray<import("../../src/core/effect").Effect>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot({ [path]: content }),
    changedPaths: [path],
    proposal: null,
    runId: "run-claim-index",
    signal: new AbortController().signal,
    input: { kind: "adoption" } as unknown,
  });
  return claimIndex.run(ctx);
}

describe("dome.claims.index same-page key-collision diagnostic", () => {
  test("same key asserted with two distinct values on one page → warning diagnostic", async () => {
    const path = "wiki/concepts/migration.md";
    const effects = await runIndex(
      path,
      "# Migration\n\n- **Status:** active\n- **Status:** shipped\n",
    );
    const collisions = effects.filter(
      (e): e is DiagnosticEffect =>
        e.kind === "diagnostic" && e.code === "dome.claims.key-collision",
    );
    expect(collisions).toHaveLength(1);
    const d = collisions[0]!;
    expect(d.severity).toBe("warning");
    expect(d.message).toContain("Status");
    expect(d.message).toContain(path);
    // Deterministic, adoption-phase: the facts still project alongside it.
    expect(effects.some((e) => e.kind === "fact")).toBe(true);
  });

  test("same key with the same value repeated is NOT a collision", async () => {
    const effects = await runIndex(
      "wiki/concepts/x.md",
      "# X\n\n- **Status:** shipped\n- **Status:** shipped\n",
    );
    expect(
      effects.some(
        (e) => e.kind === "diagnostic" && e.code === "dome.claims.key-collision",
      ),
    ).toBe(false);
  });

  test("two distinct colliding keys on one page → two diagnostics with distinct stableIds", async () => {
    const effects = await runIndex(
      "wiki/concepts/migration.md",
      "# Migration\n\n" +
        "- **Status:** active\n- **Status:** shipped\n" +
        "- **Owner:** Ada\n- **Owner:** Grace\n",
    );
    const collisions = effects.filter(
      (e): e is DiagnosticEffect =>
        e.kind === "diagnostic" && e.code === "dome.claims.key-collision",
    );
    expect(collisions).toHaveLength(2);
    const stableIds = collisions.map((c) => c.sourceRefs[0]?.stableId);
    expect(new Set(stableIds).size).toBe(2);
  });
});

describe("claimFactValue", () => {
  test("encodes key, value, and asOf as canonical JSON", () => {
    const encoded = claimFactValue({
      line: 3,
      key: "Pod managed",
      value: "[[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      asOf: "2026-05-22",
      anchor: "c1a2b3c4d",
    });
    expect(JSON.parse(encoded)).toEqual({
      key: "Pod managed",
      value: "[[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      asOf: "2026-05-22",
    });
  });

  test("omits asOf when absent", () => {
    const encoded = claimFactValue({
      line: 1,
      key: "Level",
      value: "UNI-4",
      asOf: null,
      anchor: null,
    });
    expect(JSON.parse(encoded)).toEqual({ key: "Level", value: "UNI-4" });
  });
});

import { describe, expect, test } from "bun:test";

import pageStatus from "../../assets/extensions/dome.markdown/processors/page-status";
import {
  readPageStatus,
  supersededSectionLineRanges,
  wikilinkTargetFromFrontmatterValue,
} from "../../assets/extensions/dome.markdown/processors/supersession-shared";
import type { FactEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { requireVaultPath } from "../../src/core/vault-path";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

describe("dome.markdown.page-status", () => {
  test("emits status + superseded_by facts from managed-page frontmatter", async () => {
    const effects = await runPageStatus({
      path: "wiki/concepts/old-take.md",
      content:
        "---\n" +
        "type: concept\n" +
        "status: superseded\n" +
        'superseded_by: "[[wiki/concepts/new-take]]"\n' +
        "---\n" +
        "# Old take\n",
    });

    expect(effects.length).toBe(2);
    const status = expectFact(effects, 0);
    expect(status.predicate).toBe("dome.page.status");
    expect(status.object).toEqual({ kind: "string", value: "superseded" });
    expect(status.subject).toEqual({
      kind: "page",
      path: requireVaultPath("wiki/concepts/old-take.md"),
    });
    expect(status.assertion).toBe("extracted");
    expect(status.sourceRefs[0]?.range?.startLine).toBe(3);

    const forward = expectFact(effects, 1);
    expect(forward.predicate).toBe("dome.page.superseded_by");
    expect(forward.object).toEqual({
      kind: "string",
      value: "wiki/concepts/new-take",
    });
    expect(forward.sourceRefs[0]?.range?.startLine).toBe(4);
  });

  test("emits a lone status fact when no forward link is present", async () => {
    const effects = await runPageStatus({
      path: "wiki/entities/danny.md",
      content:
        "---\n" +
        "type: entity\n" +
        "status: active\n" +
        "---\n" +
        "# Danny\n",
    });

    expect(effects.length).toBe(1);
    expect(expectFact(effects, 0).predicate).toBe("dome.page.status");
    expect(expectFact(effects, 0).object).toEqual({
      kind: "string",
      value: "active",
    });
  });

  test("emits nothing for pages without status/superseded_by frontmatter", async () => {
    const effects = await runPageStatus({
      path: "wiki/concepts/plain.md",
      content: "---\ntype: concept\n---\n# Plain\n",
    });
    expect(effects.length).toBe(0);
  });

  test("ignores user-owned optional roots", async () => {
    const effects = await runPageStatus({
      path: "notes/scratch.md",
      content: "---\nstatus: superseded\n---\n# Scratch\n",
    });
    expect(effects.length).toBe(0);
  });

  test("unquoted wikilink (YAML flow-sequence form) still yields the target", async () => {
    const effects = await runPageStatus({
      path: "wiki/syntheses/v1-plan.md",
      content:
        "---\n" +
        "type: synthesis\n" +
        "status: superseded\n" +
        "superseded_by: [[wiki/syntheses/v2-plan]]\n" +
        "---\n" +
        "# v1 plan\n",
    });
    const forward = effects
      .map((e) => e as FactEffect)
      .find((f) => f.predicate === "dome.page.superseded_by");
    expect(forward?.object).toEqual({
      kind: "string",
      value: "wiki/syntheses/v2-plan",
    });
  });
});

describe("supersession-shared parsing", () => {
  test("strips display aliases and heading fragments from forward targets", () => {
    expect(
      wikilinkTargetFromFrontmatterValue("[[wiki/concepts/x|the new one]]"),
    ).toBe("wiki/concepts/x");
    expect(
      wikilinkTargetFromFrontmatterValue("[[wiki/concepts/x#section]]"),
    ).toBe("wiki/concepts/x");
    expect(wikilinkTargetFromFrontmatterValue("wiki/concepts/x")).toBe(
      "wiki/concepts/x",
    );
    expect(wikilinkTargetFromFrontmatterValue("")).toBe(null);
    expect(wikilinkTargetFromFrontmatterValue(42)).toBe(null);
  });

  test("readPageStatus tolerates malformed YAML", () => {
    const info = readPageStatus("---\nstatus: [unclosed\n---\nbody\n");
    expect(info.status).toBe(null);
    expect(info.supersededBy).toBe(null);
  });

  test("supersededSectionLineRanges spans heading to next same-or-shallower heading", () => {
    const content = [
      "# Page", // 1
      "live prose", // 2
      "## Superseded", // 3
      "old prose [[wiki/concepts/old]]", // 4
      "### detail", // 5
      "more old prose", // 6
      "## Current", // 7
      "new prose", // 8
    ].join("\n");
    const ranges = supersededSectionLineRanges(content);
    expect(ranges).toEqual([{ startLine: 3, endLine: 6 }]);
  });

  test("a trailing Superseded section runs to end of file", () => {
    const ranges = supersededSectionLineRanges(
      "# Page\n## Superseded\nold\nolder\n",
    );
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.startLine).toBe(2);
  });
});

async function runPageStatus(opts: {
  readonly path: string;
  readonly content: string;
}) {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshotForFile(opts),
    changedPaths: [opts.path],
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-page-status",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] } as unknown,
  });

  return pageStatus.run(ctx);
}

function fakeSnapshotForFile(opts: {
  readonly path: string;
  readonly content: string;
}): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async (p: string) => (p === opts.path ? opts.content : null),
    listMarkdownFiles: async () => Object.freeze([opts.path]),
    getFileInfo: async () => null,
  });
}

function expectFact(
  effects: ReadonlyArray<unknown>,
  index: number,
): FactEffect {
  const effect = effects[index];
  if (effect === undefined) throw new Error(`expected effect at index ${index}`);
  if (typeof effect !== "object" || effect === null || !("kind" in effect)) {
    throw new Error("effect is not an object with `kind`");
  }
  if ((effect as { readonly kind: string }).kind !== "fact") {
    throw new Error(
      `expected fact effect, got ${(effect as { readonly kind: string }).kind}`,
    );
  }
  return effect as FactEffect;
}

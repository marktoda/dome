import { describe, expect, test } from "bun:test";

import staleDates from "../../assets/extensions/dome.markdown/processors/stale-dates";
import type { DiagnosticEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const BASE_COMMIT = commitOid("1111111111111111111111111111111111111111");
const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

describe("dome.markdown.stale-dates", () => {
  test("rebuild-style runs report info when updated trails git lastChangedAt", async () => {
    const effects = await runStaleDates({
      path: "wiki/project-alpha.md",
      content:
        "---\n" +
        "type: project\n" +
        "updated: 2026-05-01\n" +
        "---\n" +
        "# Project Alpha\n",
      lastChangedAt: "2026-05-28T12:00:00.000Z",
      proposalBase: HEAD_COMMIT,
      proposalHead: HEAD_COMMIT,
    });

    expect(effects.length).toBe(1);
    const diagnostic = expectDiagnostic(effects, 0);
    expect(diagnostic.severity).toBe("info");
    expect(diagnostic.code).toBe("dome.markdown.stale-updated");
    expect(diagnostic.message).toContain("was last changed on 2026-05-28");
  });

  test("active Proposals stay quiet because normalize-frontmatter repairs first", async () => {
    const effects = await runStaleDates({
      path: "wiki/project-alpha.md",
      content:
        "---\n" +
        "type: project\n" +
        "updated: 2026-05-01\n" +
        "---\n" +
        "# Project Alpha\n",
      lastChangedAt: "2026-05-28T12:00:00.000Z",
      proposalBase: BASE_COMMIT,
      proposalHead: HEAD_COMMIT,
    });

    expect(effects.length).toBe(0);
  });

  test("ignores user-owned notes markdown", async () => {
    const effects = await runStaleDates({
      path: "notes/project-alpha.md",
      content:
        "---\n" +
        "updated: 2026-05-01\n" +
        "---\n" +
        "# Project Alpha\n",
      lastChangedAt: "2026-05-28T12:00:00.000Z",
      proposalBase: HEAD_COMMIT,
      proposalHead: HEAD_COMMIT,
    });

    expect(effects.length).toBe(0);
  });
});

async function runStaleDates(opts: {
  readonly path: string;
  readonly content: string;
  readonly lastChangedAt: string;
  readonly proposalBase: CommitOid;
  readonly proposalHead: CommitOid;
}) {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshotForFile(opts),
    changedPaths: [opts.path],
    proposal: makeManualProposal({
      base: opts.proposalBase,
      head: opts.proposalHead,
      branch: "main",
    }),
    runId: "run-stale-dates",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] } as unknown,
  });

  return staleDates.run(ctx);
}

function fakeSnapshotForFile(opts: {
  readonly path: string;
  readonly content: string;
  readonly lastChangedAt: string;
}): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async (p: string) => (p === opts.path ? opts.content : null),
    listMarkdownFiles: async () => Object.freeze([opts.path]),
    getFileInfo: async (p: string) =>
      p === opts.path
        ? {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: opts.lastChangedAt,
            lastHumanChangedAt: opts.lastChangedAt,
          }
        : null,
  });
}

function expectDiagnostic(
  effects: ReadonlyArray<unknown>,
  index: number,
): DiagnosticEffect {
  const effect = effects[index];
  if (effect === undefined) throw new Error(`expected effect at index ${index}`);
  if (typeof effect !== "object" || effect === null || !("kind" in effect)) {
    throw new Error("effect is not an object with `kind`");
  }
  if ((effect as { readonly kind: string }).kind !== "diagnostic") {
    throw new Error(
      `expected diagnostic effect, got ${(effect as { readonly kind: string }).kind}`,
    );
  }
  return effect as DiagnosticEffect;
}

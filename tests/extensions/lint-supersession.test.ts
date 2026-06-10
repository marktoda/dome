import { describe, expect, test } from "bun:test";

import lintSupersession from "../../assets/extensions/dome.markdown/processors/lint-supersession";
import type { DiagnosticEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { requireVaultPath } from "../../src/core/vault-path";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

const SUPERSEDED_PAGE = (forward: string | null): string =>
  "---\n" +
  "type: concept\n" +
  "status: superseded\n" +
  (forward !== null ? `superseded_by: "[[${forward}]]"\n` : "") +
  "---\n" +
  "# Old take\n";

const LIVE_TARGET = "---\ntype: concept\n---\n# New take\n";

describe("dome.markdown.lint-supersession — missing forward link (rule 1)", () => {
  test("superseded page without superseded_by gets a warning", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE(null),
    });
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.severity).toBe("warning");
    expect(diagnostics[0]?.code).toBe(
      "dome.markdown.superseded-missing-forward-link",
    );
    expect(diagnostics[0]?.message).toContain("no `superseded_by:`");
    // Anchored to the status: line.
    expect(diagnostics[0]?.sourceRefs[0]?.range?.startLine).toBe(3);
  });

  test("superseded page with an unresolvable forward target gets a warning", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/missing"),
    });
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.code).toBe(
      "dome.markdown.superseded-missing-forward-link",
    );
    expect(diagnostics[0]?.message).toContain("[[wiki/concepts/missing]]");
    // Anchored to the superseded_by: line.
    expect(diagnostics[0]?.sourceRefs[0]?.range?.startLine).toBe(4);
  });

  test("superseded page with a resolvable forward link is clean", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
    });
    expect(diagnostics).toEqual([]);
  });

  test("user-owned notes are outside rule 1's managed scope", async () => {
    const diagnostics = await runLint({
      "notes/scratch.md": "---\nstatus: superseded\n---\n# Scratch\n",
    });
    expect(diagnostics).toEqual([]);
  });
});

describe("dome.markdown.lint-supersession — link to superseded (rule 2)", () => {
  test("live page linking a superseded page gets an info hint with the forward target", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
      "wiki/concepts/live.md":
        "---\ntype: concept\n---\n# Live\nSee [[wiki/concepts/old]] for background.\n",
    });
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.severity).toBe("info");
    expect(diagnostics[0]?.code).toBe("dome.markdown.link-to-superseded");
    expect(diagnostics[0]?.message).toContain("wiki/concepts/old.md");
    expect(diagnostics[0]?.message).toContain(
      "Current content lives at [[wiki/concepts/new.md]]",
    );
    expect(diagnostics[0]?.sourceRefs[0]?.path).toBe(
      requireVaultPath("wiki/concepts/live.md"),
    );
    expect(diagnostics[0]?.sourceRefs[0]?.range?.startChar).toBeDefined();
  });

  test("links inside a ## Superseded section are exempt history context", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
      "wiki/concepts/mixed.md":
        "---\ntype: concept\n---\n" +
        "# Mixed\n" +
        "current prose\n" +
        "## Superseded\n" +
        "we used to think [[wiki/concepts/old]] was right\n" +
        "## Current\n" +
        "now we know better\n",
    });
    expect(diagnostics).toEqual([]);
  });

  test("a link after the ## Superseded section ends is flagged again", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
      "wiki/concepts/mixed.md":
        "---\ntype: concept\n---\n" +
        "# Mixed\n" +
        "## Superseded\n" +
        "old context\n" +
        "## Current\n" +
        "still citing [[wiki/concepts/old]] as if current\n",
    });
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]?.code).toBe("dome.markdown.link-to-superseded");
  });

  test("the frontmatter superseded_by chain is never flagged", async () => {
    // A page that records superseded_by toward a superseded page but is not
    // itself flipped yet — the chain line is exempt, the body is not.
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
      "wiki/concepts/chained.md":
        "---\n" +
        "type: concept\n" +
        'superseded_by: "[[wiki/concepts/old]]"\n' +
        "---\n" +
        "# Chained\n",
    });
    expect(diagnostics).toEqual([]);
  });

  test("a superseded page linking another superseded page is history, not attention", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/older.md":
        "---\ntype: concept\nstatus: superseded\n" +
        'superseded_by: "[[wiki/concepts/old]]"\n---\n' +
        "# Older\nbuilt on [[wiki/concepts/old]]\n",
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
    });
    expect(diagnostics).toEqual([]);
  });

  test("two flagged links on one line keep distinct char offsets", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/old.md": SUPERSEDED_PAGE("wiki/concepts/new"),
      "wiki/concepts/new.md": LIVE_TARGET,
      "wiki/concepts/live.md":
        "---\ntype: concept\n---\n" +
        "[[wiki/concepts/old]] and [[wiki/concepts/old|again]]\n",
    });
    expect(diagnostics.length).toBe(2);
    const offsets = diagnostics.map((d) => d.sourceRefs[0]?.range?.startChar);
    expect(new Set(offsets).size).toBe(2);
  });

  test("links between live pages stay silent", async () => {
    const diagnostics = await runLint({
      "wiki/concepts/a.md": "---\ntype: concept\n---\nsee [[wiki/concepts/b]]\n",
      "wiki/concepts/b.md": LIVE_TARGET,
    });
    expect(diagnostics).toEqual([]);
  });
});

async function runLint(
  files: Readonly<Record<string, string>>,
): Promise<ReadonlyArray<DiagnosticEffect>> {
  const paths = Object.keys(files);
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async (p: string) => files[p] ?? null,
    listMarkdownFiles: async () => Object.freeze(paths),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: paths,
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-lint-supersession",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] } as unknown,
  });
  const effects = await lintSupersession.run(ctx);
  for (const effect of effects) {
    expect((effect as { kind: string }).kind).toBe("diagnostic");
  }
  return effects as ReadonlyArray<DiagnosticEffect>;
}

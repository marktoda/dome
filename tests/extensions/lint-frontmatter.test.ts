import { describe, expect, test } from "bun:test";

import lintFrontmatter from "../../assets/extensions/dome.markdown/processors/lint-frontmatter";
import type { DiagnosticEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { commitOid } from "../../src/core/source-ref";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

const MISSING_DESCRIPTION_CODE = "dome.markdown.missing-description";

describe("dome.markdown.lint-frontmatter — missing description (gradual-fill nudge)", () => {
  test("wiki page without description gets an info-severity missing-description finding", async () => {
    const diagnostics = await runLint({
      "wiki/entities/no-desc.md": "---\ntype: entity\n---\n# X\n",
    });
    const finding = diagnostics.find(
      (d) => d.code === MISSING_DESCRIPTION_CODE,
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("description:");
  });

  test("blank description still counts as missing", async () => {
    const diagnostics = await runLint({
      "wiki/entities/blank.md":
        '---\ntype: entity\ndescription: "  "\n---\n# X\n',
    });
    expect(
      diagnostics.some((d) => d.code === MISSING_DESCRIPTION_CODE),
    ).toBe(true);
  });

  test("description present or notes/ path gets no missing-description finding", async () => {
    const ok = await runLint({
      "wiki/entities/ok.md": "---\ntype: entity\ndescription: fine\n---\n# X\n",
    });
    expect(ok.some((d) => d.code === MISSING_DESCRIPTION_CODE)).toBe(false);

    const notes = await runLint({
      "notes/meeting.md": "---\ntype: source\n---\n# N\n",
    });
    expect(notes.some((d) => d.code === MISSING_DESCRIPTION_CODE)).toBe(false);
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
    runId: "run-lint-frontmatter",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] } as unknown,
  });
  const effects = await lintFrontmatter.run(ctx);
  for (const effect of effects) {
    expect((effect as { kind: string }).kind).toBe("diagnostic");
  }
  return effects as ReadonlyArray<DiagnosticEffect>;
}

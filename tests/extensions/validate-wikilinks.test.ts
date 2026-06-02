// Phase 11d — dome.markdown.validate-wikilinks bundle tests.
//
// Verifies the first first-party adoption-phase processor end-to-end:
//   - Loading the shipped `assets/extensions/dome.markdown/` bundle
//     resolves manifest + module + identity-cross-check.
//   - The processor's `run` against a real git-backed vault snapshot:
//     - Emits no diagnostics when every wikilink resolves.
//     - Emits a PatchEffect for high-confidence curated-page typo repairs.
//     - Emits a `dome.markdown.broken-wikilink` warning when a target is missing
//       from a managed page, and info when the source is a user-owned note draft.
//     - Emits exactly one diagnostic per unresolved target (the resolved
//       targets in the same file produce no false positives).
//
// Uses the same git-repo fixture pattern as `tests/engine/adopt.test.ts`:
// `initRepo` + `writeFile` + `commit` produces a real commit OID that
// `readTree` / `readBlob` resolve against.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commit, fileInfoAtCommit, initRepo, readBlob, readTree } from "../../src/git";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type Processor,
  type Snapshot,
} from "../../src/core/processor";
import type {
  DiagnosticEffect,
  PatchEffect,
  QuestionEffect,
} from "../../src/core/effect";
import { makeProcessorContext } from "../../src/processors/context";
import {
  flattenBundleProcessors,
  loadBundles,
} from "../../src/extensions/loader";

// ----- Paths ---------------------------------------------------------------

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

// ----- Fixture: a real git-backed vault ------------------------------------
//
// `initRepo` + per-file `writeFile` + `commit` produces a real commit OID. We
// then resolve the tree OID via `readTree` to build a Snapshot whose
// `readFile` / `listMarkdownFiles` closures hit the live git boundary.

type Fixture = {
  readonly vaultPath: string;
  readonly commit: CommitOid;
  readonly snapshot: Snapshot;
  readonly cleanup: () => Promise<void>;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

async function makeVaultWithFiles(
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "wikilinks-"));
  await initRepo(vaultPath);

  // Materialize each file (creating parent dirs as needed).
  for (const f of files) {
    const abs = join(vaultPath, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
  }

  const commitSha = await commit({
    path: vaultPath,
    message: "fixture\n",
    files: files.map((f) => f.path),
  });
  const c = commitOid(commitSha);

  // Resolve the tree OID at the commit. isomorphic-git's readTree dereferences
  // a commit OID and returns the underlying tree's OID on `.oid`.
  const treeResult = await readTree({ path: vaultPath, oid: commitSha });
  const tree = treeOid(treeResult.oid);

  // Live Snapshot — readFile / listMarkdownFiles hit the real git boundary
  // via src/git.ts. Mirrors the closures the processors runtime builds in
  // src/processors/runtime.ts.
  const snapshot: Snapshot = Object.freeze({
    commit: c,
    tree,
    readFile: (p: string) =>
      readBlob({ path: vaultPath, commit: commitSha, filepath: p }),
    listMarkdownFiles: () => listAllMarkdown(vaultPath, commitSha),
    getFileInfo: async (p: string) => {
      const info = await fileInfoAtCommit({ path: vaultPath, commit: commitSha, filepath: p });
      if (info === null) return null;
      return {
        lastChangedCommit: commitOid(info.lastChangedCommit),
        lastChangedAt: info.lastChangedAt,
      };
    },
  });

  const cleanup = async (): Promise<void> => {
    await rm(vaultPath, { recursive: true, force: true });
  };
  return { vaultPath, commit: c, snapshot, cleanup };
}

async function listAllMarkdown(
  vaultPath: string,
  commitSha: string,
): Promise<ReadonlyArray<string>> {
  const out: string[] = [];
  await walkForMarkdown(vaultPath, commitSha, "", out);
  out.sort();
  return Object.freeze(out);
}

async function walkForMarkdown(
  vaultPath: string,
  oid: string,
  prefix: string,
  out: string[],
): Promise<void> {
  const t = await readTree({ path: vaultPath, oid });
  for (const entry of t.tree) {
    const p = prefix === "" ? entry.path : `${prefix}/${entry.path}`;
    if (entry.type === "tree") {
      await walkForMarkdown(vaultPath, entry.oid, p, out);
    } else if (entry.type === "blob" && p.endsWith(".md")) {
      out.push(p);
    }
  }
}

// ----- Load the processor once per describe block -------------------------

async function loadProcessor(): Promise<Processor<unknown>> {
  const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
  if (!result.ok) {
    throw new Error(`loadBundles failed: ${result.error.kind}`);
  }
  const flat = flattenBundleProcessors(result.value);
  const proc = flat.find((p) => p.id === "dome.markdown.validate-wikilinks");
  if (proc === undefined) {
    throw new Error("dome.markdown.validate-wikilinks not loaded");
  }
  return proc;
}

// ----- Tests ---------------------------------------------------------------

describe("dome.markdown.validate-wikilinks", () => {
  test("resolves an internal wikilink correctly → no diagnostics", async () => {
    const f = await makeVaultWithFiles([
      { path: "wiki/a.md", content: "Linking to [[b]] here.\n" },
      { path: "wiki/b.md", content: "I am b.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/a.md"],
      proposal: null,
      runId: "run-test-1",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("surfaces a broken wikilink with code dome.markdown.broken-wikilink", async () => {
    const f = await makeVaultWithFiles([
      { path: "wiki/a.md", content: "Linking to [[nonexistent]] here.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/a.md"],
      proposal: null,
      runId: "run-test-2",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const eff = effects[0];
    if (eff === undefined) throw new Error("expected one effect");
    expect(eff.kind).toBe("diagnostic");
    const diag = eff as DiagnosticEffect;
    expect(diag.severity).toBe("warning");
    expect(diag.code).toBe("dome.markdown.broken-wikilink");
    expect(diag.message).toContain("nonexistent");

    // sourceRef anchors to wiki/a.md at the commit; line 1 (single-line file).
    expect(diag.sourceRefs.length).toBe(1);
    const ref = diag.sourceRefs[0];
    if (ref === undefined) throw new Error("expected one source ref");
    expect(ref.path as string).toBe("wiki/a.md");
    expect(ref.commit).toBe(f.commit);
    expect(ref.range?.startLine).toBe(1);
  });

  test("auto-repairs a close existing markdown target for curated-page typoed wikilinks", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "wiki/page.md",
        content: "Working with [[wiki/entities/grce-danco#Notes|Grace]].\n",
      },
      { path: "wiki/entities/grace-danco.md", content: "Grace.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/page.md"],
      proposal: null,
      runId: "run-test-suggestion",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const patch = effects[0] as PatchEffect | undefined;
    if (patch === undefined) throw new Error("expected one patch");
    expect(patch.kind).toBe("patch");
    expect(patch.mode).toBe("auto");
    const change = patch.changes[0];
    expect(change?.kind).toBe("write");
    if (change?.kind !== "write") throw new Error("expected write change");
    expect(String(change?.path)).toBe("wiki/page.md");
    expect(change?.content).toBe(
      "Working with [[wiki/entities/grace-danco#Notes|Grace]].\n",
    );
    expect(String(patch.sourceRefs[0]?.path)).toBe("wiki/page.md");
  });

  test("asks an agent-safe question when a managed wikilink has ambiguous close targets", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "wiki/page.md",
        content: "Working with [[wiki/entities/grae-danco]].\n",
      },
      { path: "wiki/entities/grace-danco.md", content: "Grace.\n" },
      { path: "wiki/entities/grade-danco.md", content: "Grade.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/page.md"],
      proposal: null,
      runId: "run-test-ambiguous-suggestion",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(2);

    const diag = effects[0] as DiagnosticEffect | undefined;
    if (diag === undefined) throw new Error("expected one diagnostic");
    expect(diag.message).toContain("[[wiki/entities/grae-danco]]");
    expect(diag.message).not.toContain("Did you mean");

    const question = effects[1] as QuestionEffect | undefined;
    if (question === undefined) throw new Error("expected one question");
    expect(question.kind).toBe("question");
    expect(question.question).toContain("[[wiki/entities/grae-danco]]");
    expect(question.question).toContain("[[wiki/entities/grace-danco]]");
    expect(question.question).toContain("[[wiki/entities/grade-danco]]");
    expect(question.options).toEqual([
      "wiki/entities/grace-danco",
      "wiki/entities/grade-danco",
      "keep unresolved",
    ]);
    expect(question.idempotencyKey).toMatch(
      /^dome\.markdown\.ambiguous-wikilink:/,
    );
    expect(question.metadata).toEqual(
      expect.objectContaining({
        automationPolicy: "agent-safe",
        risk: "medium",
      }),
    );
    expect(question.sourceRefs[0]?.path as string).toBe("wiki/page.md");
  });

  test("does not ask questions for ambiguous note-draft wikilinks", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "notes/scratch.md",
        content: "Working with [[wiki/entities/grae-danco]].\n",
      },
      { path: "wiki/entities/grace-danco.md", content: "Grace.\n" },
      { path: "wiki/entities/grade-danco.md", content: "Grade.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["notes/scratch.md"],
      proposal: null,
      runId: "run-test-ambiguous-note",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);
    expect(effects[0]?.kind).toBe("diagnostic");
  });

  test("surfaces broken note-draft wikilinks as info diagnostics", async () => {
    const f = await makeVaultWithFiles([
      { path: "notes/scratch.md", content: "Maybe [[future-idea]].\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["notes/scratch.md"],
      proposal: null,
      runId: "run-test-note-info",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const diag = effects[0] as DiagnosticEffect | undefined;
    if (diag === undefined) throw new Error("expected one diagnostic");
    expect(diag.severity).toBe("info");
    expect(diag.code).toBe("dome.markdown.broken-wikilink");
    expect(diag.message).toContain("future-idea");
    expect(diag.sourceRefs[0]?.path as string).toBe("notes/scratch.md");
  });

  test("keeps source frontmatter links warning while source body links are info", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "wiki/sources/imported-scan.md",
        content: [
          "---",
          "type: source",
          "sources:",
          "  - \"[[notes/missing-import-note]]\"",
          "---",
          "",
          "Imported body mentions [[wiki/entities/missing-person]].",
          "",
        ].join("\n"),
      },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/sources/imported-scan.md"],
      proposal: null,
      runId: "run-test-source-body-info",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(2);

    const diagnostics = effects as DiagnosticEffect[];
    const byTarget = new Map(
      diagnostics.map((diagnostic) => [diagnostic.message, diagnostic]),
    );
    const sourceLink = [...byTarget].find(([message]) =>
      message.includes("missing-import-note"),
    )?.[1];
    const bodyLink = [...byTarget].find(([message]) =>
      message.includes("missing-person"),
    )?.[1];

    expect(sourceLink?.severity).toBe("warning");
    expect(sourceLink?.sourceRefs[0]?.range?.startLine).toBe(4);
    expect(bodyLink?.severity).toBe("info");
    expect(bodyLink?.sourceRefs[0]?.range?.startLine).toBe(7);
  });

  test("multiple wikilinks per file → exactly one diagnostic for the missing target", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "wiki/page.md",
        content: "Pointing at [[a]] and [[b]] and [[missing]].\n",
      },
      { path: "wiki/a.md", content: "A.\n" },
      { path: "wiki/b.md", content: "B.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/page.md"],
      proposal: null,
      runId: "run-test-3",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const eff = effects[0];
    if (eff === undefined) throw new Error("expected one effect");
    expect(eff.kind).toBe("diagnostic");
    const diag = eff as DiagnosticEffect;
    expect(diag.code).toBe("dome.markdown.broken-wikilink");
    expect(diag.message).toContain("missing");
    expect(diag.message).not.toContain("[[a]]");
    expect(diag.message).not.toContain("[[b]]");
  });

  test("ignores literal wikilink examples in code spans and fenced code blocks", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "wiki/page.md",
        content: [
          "Inline example `[[not-a-real-link]]` should be ignored.",
          "",
          "```md",
          "[[also-not-real]]",
          "```",
          "",
          "Authored link [[actually-missing]] should still be reported.",
          "",
        ].join("\n"),
      },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/page.md"],
      proposal: null,
      runId: "run-test-code-examples",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const diag = effects[0] as DiagnosticEffect | undefined;
    if (diag === undefined) throw new Error("expected one diagnostic");
    expect(diag.message).toContain("actually-missing");
    expect(diag.message).not.toContain("not-a-real-link");
    expect(diag.message).not.toContain("also-not-real");
  });

  test("does not lint external markdown paths while still resolving targets there", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "cohesive/history.md",
        content: "Historical note with [[old-missing-target]].\n",
      },
      {
        path: "wiki/page.md",
        content: "Project source is [[cohesive/source-note]].\n",
      },
      {
        path: "cohesive/source-note.md",
        content: "External source note.\n",
      },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["cohesive/history.md", "wiki/page.md"],
      proposal: null,
      runId: "run-test-external-roots",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  // Regression: [[parent/child]] resolves to <anything>/parent/child.md via
  // suffix-match. Pre-fix, the resolver only tried vault-root-relative
  // paths and would flag this as broken.
  test("partial-path wikilink [[entities/danny]] resolves via suffix-match", async () => {
    const f = await makeVaultWithFiles([
      { path: "wiki/page.md", content: "Hello [[entities/danny]].\n" },
      { path: "wiki/entities/danny.md", content: "Danny.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/page.md"],
      proposal: null,
      runId: "run-test-suffix",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("resolves Obsidian heading fragments against the owning markdown file", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "notes/source.md",
        content: "See [[Property Management Software Market Analysis#Pain Points]] and [[#Local]].\n",
      },
      {
        path: "notes/Property Management Software Market Analysis.md",
        content: "# Property Management Software Market Analysis\n\n## Pain Points\n",
      },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["notes/source.md"],
      proposal: null,
      runId: "run-test-heading-fragments",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("resolves unique normalized title links to slugged markdown paths", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "notes/team.md",
        content: "Working with [[Grace Danco]] and [[wiki/entities/Grace Danco]].\n",
      },
      { path: "wiki/entities/grace-danco.md", content: "Grace.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["notes/team.md"],
      proposal: null,
      runId: "run-test-normalized-title",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("keeps ambiguous normalized title links unresolved", async () => {
    const f = await makeVaultWithFiles([
      { path: "notes/team.md", content: "Working with [[Grace Danco]].\n" },
      { path: "wiki/entities/grace-danco.md", content: "Grace entity.\n" },
      { path: "notes/grace danco.md", content: "Grace note.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["notes/team.md"],
      proposal: null,
      runId: "run-test-normalized-ambiguous",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);
    const diag = effects[0] as DiagnosticEffect | undefined;
    if (diag === undefined) throw new Error("expected one diagnostic");
    expect(diag.message).toContain("Grace Danco");
  });

  test("skips non-markdown attachment, URL, and template wikilinks", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "notes/page.md",
        content: [
          "Attachment [[raw/level-guide.pdf]].",
          "Base [[Recently Updated Files.base]].",
          "External [[https://example.com/doc#section]].",
          "Template [[dailies/<% tp.date.now(\"YYYY-MM-DD\", +1) %>]].",
          "Actual missing [[really-missing]].",
          "",
        ].join("\n"),
      },
      { path: "raw/level-guide.pdf", content: "not actually a pdf\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["notes/page.md"],
      proposal: null,
      runId: "run-test-skip-non-markdownish",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);
    const diag = effects[0] as DiagnosticEffect | undefined;
    if (diag === undefined) throw new Error("expected one diagnostic");
    expect(diag.message).toContain("really-missing");
    expect(diag.message).not.toContain("level-guide");
    expect(diag.message).not.toContain("Recently Updated");
    expect(diag.message).not.toContain("example.com");
    expect(diag.message).not.toContain("tp.date.now");
  });

  // Regression: two broken wikilinks on the same line produced one diagnostic
  // after dedup (the source-refs hash was line-level, so the second collided
  // with the first). Now each wikilink carries its own startChar/endChar in
  // the SourceRef, distinct per-match.
  test("two broken wikilinks on one line → two distinct diagnostics with distinct ranges", async () => {
    const f = await makeVaultWithFiles([
      {
        path: "wiki/page.md",
        content: "On one line: [[fake-alpha]] and also [[fake-beta]].\n",
      },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/page.md"],
      proposal: null,
      runId: "run-test-coline",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(2);

    const diagnostics = effects.map((e) => e as DiagnosticEffect);
    const ranges = diagnostics.map((d) => d.sourceRefs[0]?.range);

    // Both on line 1, but distinct character spans.
    expect(ranges[0]?.startLine).toBe(1);
    expect(ranges[1]?.startLine).toBe(1);
    expect(ranges[0]?.startChar).toBeDefined();
    expect(ranges[1]?.startChar).toBeDefined();
    expect(ranges[0]?.startChar).not.toBe(ranges[1]?.startChar);
  });
});

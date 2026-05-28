// Phase 12b — dome.markdown.normalize-frontmatter bundle tests.
//
// Verifies the first patch-emitting adoption-phase processor end-to-end:
//   - Loading the shipped `assets/extensions/dome.markdown/` bundle resolves
//     manifest + module + identity-cross-check.
//   - The processor's `run` against a real git-backed vault snapshot:
//     - Emits no effects when the file has no frontmatter.
//     - Emits no effects when the frontmatter is already canonical (the
//       idempotency contract's base case).
//     - Emits one PatchEffect{mode: "auto"} with one FileChange{kind: "write"}
//       when keys are in the wrong order.
//     - Batches multiple changed files into one PatchEffect carrying one
//       FileChange per file that needed reordering.
//     - Emits no effects when YAML is malformed (skip silently; diagnostics
//       are a separate processor's responsibility).
//     - Emits no effects when re-run on its own output (the load-bearing
//       idempotency contract — without this the fixed-point adoption loop
//       would diverge).
//
// Uses the same git-repo fixture pattern as
// `tests/extensions/validate-wikilinks.test.ts`: `initRepo` + per-file
// `writeFile` + `commit` produces a real commit OID; `readTree` / `readBlob`
// resolve against it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commit, initRepo, readBlob, readTree } from "../../src/git";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type Processor,
  type Snapshot,
} from "../../src/core/processor";
import type { FileChange, PatchEffect } from "../../src/core/effect";
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
// Mirrors the fixture in `validate-wikilinks.test.ts` so the two extension
// tests share an obvious shape. `initRepo` + per-file `writeFile` + `commit`
// produces a real commit OID; we then resolve the tree OID at the commit
// and build a Snapshot whose `readFile` / `listMarkdownFiles` closures hit
// the live git boundary (same shape the engine's processor runtime
// constructs at runtime).

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
  const vaultPath = mkdtempSync(join(tmpdir(), "normalize-fm-"));
  await initRepo(vaultPath);

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

  const treeResult = await readTree({ path: vaultPath, oid: commitSha });
  const tree = treeOid(treeResult.oid);

  const snapshot: Snapshot = Object.freeze({
    commit: c,
    tree,
    readFile: (p: string) =>
      readBlob({ path: vaultPath, commit: commitSha, filepath: p }),
    listMarkdownFiles: () => listAllMarkdown(vaultPath, commitSha),
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

// ----- Load the processor once per test ------------------------------------

async function loadProcessor(): Promise<Processor<unknown>> {
  const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
  if (!result.ok) {
    throw new Error(`loadBundles failed: ${result.error.kind}`);
  }
  const flat = flattenBundleProcessors(result.value);
  const proc = flat.find((p) => p.id === "dome.markdown.normalize-frontmatter");
  if (proc === undefined) {
    throw new Error("dome.markdown.normalize-frontmatter not loaded");
  }
  return proc;
}

// ----- Helpers --------------------------------------------------------------

/** Build a markdown body with the given frontmatter prelude. */
function withFrontmatter(prelude: string, body: string): string {
  return `---\n${prelude}---\n${body}`;
}

/** Narrow an Effect[] entry to a PatchEffect, asserting kind. */
function expectPatch(effects: ReadonlyArray<unknown>, index: number): PatchEffect {
  const eff = effects[index];
  if (eff === undefined) throw new Error(`expected effect at index ${index}`);
  if (typeof eff !== "object" || eff === null || !("kind" in eff)) {
    throw new Error("effect is not an object with `kind`");
  }
  const e = eff as { kind: string };
  if (e.kind !== "patch") {
    throw new Error(`expected patch effect, got ${e.kind}`);
  }
  return eff as PatchEffect;
}

/** Narrow a FileChange[] entry to a write, asserting kind. */
function expectWrite(
  changes: ReadonlyArray<FileChange>,
  index: number,
): { path: string; content: string } {
  const ch = changes[index];
  if (ch === undefined) throw new Error(`expected change at index ${index}`);
  if (ch.kind !== "write") {
    throw new Error(`expected write change, got ${ch.kind}`);
  }
  return { path: ch.path, content: ch.content };
}

// ----- Tests ----------------------------------------------------------------

describe("dome.markdown.normalize-frontmatter", () => {
  test("file with no frontmatter → 0 effects", async () => {
    const f = await makeVaultWithFiles([
      { path: "wiki/plain.md", content: "# Just a body, no frontmatter.\n" },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/plain.md"],
      proposal: null,
      runId: "run-nfm-1",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("frontmatter already in canonical order → 0 effects (idempotency base case)", async () => {
    // type, id (the first two canonical keys) in correct order, with
    // simple string values that round-trip identity-clean through
    // js-yaml's safeLoad / safeDump (no Date coercion, no quote-style
    // ambiguity, no flow-vs-block choice). The processor's `normalized
    // === content` short-circuit fires here: parse → reorder (no-op,
    // already canonical) → stringify produces byte-identical YAML, so
    // the processor emits zero effects.
    //
    // The fuller "round-trip on processor output" case is in test #6
    // below; this test pins the simpler static base case so a regression
    // in either path produces a distinct failure signal.
    const canonical = withFrontmatter("type: entity\nid: danny\n", "# Danny\n");
    const f = await makeVaultWithFiles([
      { path: "wiki/danny.md", content: canonical },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/danny.md"],
      proposal: null,
      runId: "run-nfm-2",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("keys in wrong order → 1 PatchEffect with 1 FileChange(write) carrying reordered content", async () => {
    // Reverse of canonical: sources, updated, created, tags, aliases, id, type.
    const wrongOrder = withFrontmatter(
      "sources: []\nupdated: 2026-05-27\ncreated: 2026-05-27\ntags: []\naliases: []\nid: danny\ntype: entity\n",
      "# Danny\n",
    );
    const f = await makeVaultWithFiles([
      { path: "wiki/danny.md", content: wrongOrder },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/danny.md"],
      proposal: null,
      runId: "run-nfm-3",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("auto");
    expect(patch.reason).toBe("normalize frontmatter key order");
    expect(patch.changes.length).toBe(1);

    const write = expectWrite(patch.changes, 0);
    expect(write.path).toBe("wiki/danny.md");

    // The new content's frontmatter starts with `type:` (canonical first key),
    // and `sources:` (the old first key) comes near the end. We don't assert
    // exact YAML whitespace because gray-matter's serializer choices are an
    // upstream detail — but the relative key ordering is the invariant.
    const typeIdx = write.content.indexOf("type:");
    const sourcesIdx = write.content.indexOf("sources:");
    const idIdx = write.content.indexOf("id:");
    const updatedIdx = write.content.indexOf("updated:");
    expect(typeIdx).toBeGreaterThan(0);
    expect(idIdx).toBeGreaterThan(typeIdx);
    expect(updatedIdx).toBeGreaterThan(idIdx);
    expect(sourcesIdx).toBeGreaterThan(updatedIdx);

    // SourceRef anchored to the changed file at the snapshot's commit.
    expect(patch.sourceRefs.length).toBe(1);
    const ref = patch.sourceRefs[0];
    if (ref === undefined) throw new Error("expected one source ref");
    expect(ref.path).toBe("wiki/danny.md");
    expect(ref.commit).toBe(f.commit);
  });

  test("multiple changed files, some need fixing → one PatchEffect, one FileChange per file that changed", async () => {
    const wrongOrder = withFrontmatter(
      "sources: []\ntype: entity\n",
      "# Wrong order\n",
    );
    const canonical = withFrontmatter(
      "type: entity\nsources: []\n",
      "# Canonical\n",
    );
    const noFrontmatter = "# Plain body, no frontmatter\n";

    const f = await makeVaultWithFiles([
      { path: "wiki/needs-fix.md", content: wrongOrder },
      { path: "wiki/already-good.md", content: canonical },
      { path: "wiki/plain.md", content: noFrontmatter },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: [
        "wiki/needs-fix.md",
        "wiki/already-good.md",
        "wiki/plain.md",
      ],
      proposal: null,
      runId: "run-nfm-4",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(1);

    const patch = expectPatch(effects, 0);
    expect(patch.changes.length).toBe(1);
    const write = expectWrite(patch.changes, 0);
    expect(write.path).toBe("wiki/needs-fix.md");
  });

  test("malformed YAML in frontmatter → 0 effects (skip, no diagnostic)", async () => {
    // Unbalanced bracket → js-yaml throws → gray-matter rethrows → we swallow.
    const malformed = "---\ntype: [unclosed\nid: bad\n---\n\n# Body\n";

    const f = await makeVaultWithFiles([
      { path: "wiki/broken.md", content: malformed },
    ]);
    fixtures.push(f);

    const proc = await loadProcessor();
    const ctx = makeProcessorContext({
      snapshot: f.snapshot,
      changedPaths: ["wiki/broken.md"],
      proposal: null,
      runId: "run-nfm-5",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });

    const effects = await proc.run(ctx);
    expect(effects.length).toBe(0);
  });

  test("idempotency: re-running the processor on its own output produces 0 effects", async () => {
    // Pivotal test. The fixed-point adoption loop relies on this: after the
    // engine applies the PatchEffect from iteration 1 and re-runs the
    // processor in iteration 2, the processor MUST see "already canonical"
    // and emit nothing — otherwise the loop diverges.
    const wrongOrder = withFrontmatter(
      "tags: [foo]\ncreated: 2026-05-27\ntype: source\nid: paper-1\n",
      "# Paper\n",
    );

    // --- Phase 1: run on wrong-order content, capture the patched output.
    const f1 = await makeVaultWithFiles([
      { path: "wiki/paper.md", content: wrongOrder },
    ]);
    fixtures.push(f1);

    const proc = await loadProcessor();
    const ctx1 = makeProcessorContext({
      snapshot: f1.snapshot,
      changedPaths: ["wiki/paper.md"],
      proposal: null,
      runId: "run-nfm-6a",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });
    const effects1 = await proc.run(ctx1);
    expect(effects1.length).toBe(1);
    const patch1 = expectPatch(effects1, 0);
    const write1 = expectWrite(patch1.changes, 0);
    const normalizedContent = write1.content;

    // --- Phase 2: build a fresh fixture whose committed file IS the
    // normalized content. The candidate's snapshot now returns the patched
    // bytes from `readFile`, which is what the engine would surface to
    // iteration 2 after the closure commit.
    const f2 = await makeVaultWithFiles([
      { path: "wiki/paper.md", content: normalizedContent },
    ]);
    fixtures.push(f2);

    const ctx2 = makeProcessorContext({
      snapshot: f2.snapshot,
      changedPaths: ["wiki/paper.md"],
      proposal: null,
      runId: "run-nfm-6b",
      signal: new AbortController().signal,
      input: { kind: "adoption", matchedTriggers: [] } as unknown,
    });
    const effects2 = await proc.run(ctx2);

    // The load-bearing assertion: 0 effects when run on the processor's
    // own output. If this fires, the fixed-point loop would not converge.
    expect(effects2.length).toBe(0);
  });
});

// Perf regression guard for the dome.markdown adoption-lint processors.
//
// Live-vault ops evidence (14-day audit): at ~978 markdown files the
// `all-readable-markdown` adoption lints — `lint-supersession` and
// `validate-wikilinks` — repeatedly hit their 30s timeout cap. The measured
// hot path was the Snapshot read layer: `readFile` re-resolved
// commit→tree→per-path-segment on every call, turning a whole-vault scan into
// O(files × tree-depth) repeated tree decompressions. `makeSnapshot` now walks
// the commit tree once into a `path → blob-OID` index and reads each blob
// directly by OID (see src/processors/runtime.ts + src/git.ts readBlobByOid).
//
// This test builds a ~1,000-file synthetic vault (deterministic content from
// an index seed — no randomness) and asserts the slowest fixed processor runs
// well under the old 30s cap. The 5s bound is a deliberately generous CI
// margin: the fixed cost is ~100-150ms locally, so a >5s run signals a real
// regression, not load jitter. The bun per-test timeout is set generously so
// the harness never kills the run before the assertion (fixture git-commit
// setup alone is ~1s) — the in-band 5s assertion is the actual guard.
//
// Runs through the real `makeSnapshot` closures from
// src/processors/runtime.ts, so the test exercises the shipped snapshot read
// path rather than a hand-rolled stand-in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commit, initRepo, readTree } from "../../src/git";
import { commitOid, type CommitOid } from "../../src/core/source-ref";
import {
  treeOid,
  type Processor,
  type Snapshot,
  type TreeOid,
} from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";
import { makeSnapshot } from "../../src/processors/runtime";
import {
  flattenBundleProcessors,
  loadBundles,
} from "../../src/extensions/loader";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..", "..");
const SHIPPED_BUNDLES_ROOT = join(REPO_ROOT, "assets", "extensions");

const FILE_COUNT = 1000;
// Generous CI margin over the ~100-150ms fixed local cost; the old cap was 30s.
const MAX_RUN_MS = 5000;

// ----- Deterministic fixture ------------------------------------------------

/**
 * Realistic-shape markdown from a pure index seed: canonical frontmatter,
 * cross-file wikilinks (resolvable + a broken one), a claim line, and prose
 * body. ~1 in 11 pages is `superseded` with a forward link so both
 * lint-supersession rules exercise. No randomness → byte-stable fixture.
 */
function seededFiles(n: number): ReadonlyArray<{ path: string; content: string }> {
  const roots = [
    "wiki/concepts",
    "wiki/entities",
    "wiki/specs",
    "notes",
    "captures",
  ] as const;
  const name = (i: number): string => `page-${String(i).padStart(4, "0")}`;
  const files: Array<{ path: string; content: string }> = [];
  for (let i = 0; i < n; i += 1) {
    const root = roots[i % roots.length];
    const l1 = name((i * 7 + 3) % n);
    const l2 = name((i * 13 + 5) % n);
    const l3 = name((i + 1) % n);
    const superseded = i % 11 === 0;
    const supBy = name((i + 2) % n);
    const content = [
      "---",
      `title: Page ${i}`,
      `status: ${superseded ? "superseded" : "active"}`,
      ...(superseded ? [`superseded_by: "[[${supBy}]]"`] : []),
      "updated: 2026-01-01",
      "---",
      "",
      `# Page ${i}`,
      "",
      `See [[${l1}]] and [[${l2}]], continued in [[${l3}]].`,
      "",
      `Claim: [[${l1}]] relates to [[missing-target-${i % 50}]].`,
      "",
      "Prose body text giving the file realistic size. ".repeat(6),
      "",
    ].join("\n");
    files.push({ path: `${root}/${name(i)}.md`, content });
  }
  return files;
}

type Fixture = {
  readonly vaultPath: string;
  readonly commit: CommitOid;
  readonly resolveTree: (commit: CommitOid) => Promise<TreeOid>;
  readonly cleanup: () => Promise<void>;
};

async function buildFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "lint-perf-"));
  await initRepo(vaultPath);
  const files = seededFiles(FILE_COUNT);
  for (const f of files) {
    const abs = join(vaultPath, f.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
  }
  const sha = await commit({
    path: vaultPath,
    message: "perf fixture\n",
    files: files.map((f) => f.path),
  });
  const c = commitOid(sha);
  const treeResult = await readTree({ path: vaultPath, oid: sha });
  const tree = treeOid(treeResult.oid);
  return {
    vaultPath,
    commit: c,
    resolveTree: async () => tree,
    cleanup: () => rm(vaultPath, { recursive: true, force: true }),
  };
}

async function loadProcessor(id: string): Promise<Processor<unknown>> {
  const result = await loadBundles({ bundlesRoot: SHIPPED_BUNDLES_ROOT });
  if (!result.ok) throw new Error(`loadBundles failed: ${result.error.kind}`);
  const proc = flattenBundleProcessors(result.value).find((p) => p.id === id);
  if (proc === undefined) throw new Error(`${id} not loaded`);
  return proc;
}

// A fresh snapshot per run mirrors the runtime (one Snapshot per dispatch);
// timing a fresh snapshot includes the one-time tree-index walk.
async function timeRun(
  fixture: Fixture,
  proc: Processor<unknown>,
): Promise<number> {
  const snapshot: Snapshot = await makeSnapshot(
    fixture.vaultPath,
    fixture.commit,
    fixture.resolveTree,
  );
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: ["wiki/concepts/page-0000.md"],
    proposal: null,
    runId: "run-perf",
    signal: new AbortController().signal,
    input: { kind: "adoption", matchedTriggers: [] } as unknown,
  });
  const started = performance.now();
  await proc.run(ctx);
  return performance.now() - started;
}

// ----- Test -----------------------------------------------------------------

describe(`dome.markdown adoption lints scale past ${FILE_COUNT} files`, () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await buildFixture();
  }, 60_000);

  afterAll(async () => {
    if (fixture !== undefined) await fixture.cleanup();
  });

  test(
    "lint-supersession + validate-wikilinks each finish well under the old 30s cap",
    async () => {
      const supersession = await loadProcessor(
        "dome.markdown.lint-supersession",
      );
      const validate = await loadProcessor("dome.markdown.validate-wikilinks");

      const supersessionMs = await timeRun(fixture, supersession);
      const validateMs = await timeRun(fixture, validate);

      expect(supersessionMs).toBeLessThan(MAX_RUN_MS);
      expect(validateMs).toBeLessThan(MAX_RUN_MS);
    },
    60_000,
  );
});

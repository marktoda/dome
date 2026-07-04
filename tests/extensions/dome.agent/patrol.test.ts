// dome.agent.patrol — the deterministic staleness patrol (product-review-3
// Task 15). A no-model garden processor that queues the stalest entity /
// concept / synthesis pages for the nightly consolidate to review, records the
// visit in a bounded ledger (35-day revisit window, 60-day retention), and
// nudges oversized pages toward a split via a self-clearing info diagnostic.

import { describe, expect, test } from "bun:test";

import patrol from "../../../assets/extensions/dome.agent/processors/patrol";
import {
  PATROL_LEDGER_PATH,
  PATROL_QUEUE_PATH,
  parsePatrolQueue,
  renderPatrolLedger,
  renderPatrolQueue,
} from "../../../assets/extensions/dome.agent/lib/patrol";
import type {
  DiagnosticEffect,
  Effect,
  PatchEffect,
} from "../../../src/core/effect";
import { treeOid, type Snapshot } from "../../../src/core/processor";
import { makeManualProposal } from "../../../src/core/proposal";
import { commitOid } from "../../../src/core/source-ref";
import { makeProcessorContext } from "../../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");

function run(opts: {
  readonly files: Readonly<Record<string, string>>;
  readonly now: string; // YYYY-MM-DD
}): Promise<ReadonlyArray<Effect>> {
  const files = opts.files;
  const snapshot: Snapshot = Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("7777777777777777777777777777777777777777"),
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(files)),
    getFileInfo: async () => null,
  });
  const ctx = makeProcessorContext({
    snapshot,
    changedPaths: Object.freeze(Object.keys(files)),
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-patrol-test",
    signal: new AbortController().signal,
    input: { kind: "garden", matchedTriggers: [] },
    now: new Date(`${opts.now}T09:00:00.000Z`),
  });
  return patrol.run(ctx as never);
}

/** A wiki page with an `updated:` frontmatter date and `bodyLines` body lines. */
function page(updated: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `line ${i + 1}`);
  return ["---", `updated: ${updated}`, "---", ...body].join("\n");
}

function patchOf(effects: ReadonlyArray<Effect>): PatchEffect | undefined {
  return effects.find((e): e is PatchEffect => e.kind === "patch");
}

function fileInPatch(patch: PatchEffect | undefined, path: string): string {
  const change = patch?.changes.find(
    (c) => c.kind === "write" && String(c.path) === path,
  );
  if (change === undefined || change.kind !== "write") {
    throw new Error(`no write change for ${path}`);
  }
  return change.content;
}

describe("dome.agent.patrol — stalest-first selection", () => {
  test("queues the 5 stalest pages, oldest first, in the queue grammar", async () => {
    const files: Record<string, string> = {};
    // Seven pages, distinct updated dates; the two most recent must fall off.
    const dates = [
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
      "2026-06-20",
    ];
    dates.forEach((d, i) => {
      files[`wiki/entities/e${i}.md`] = page(d, 10 + i);
    });

    const effects = await run({ files, now: "2026-07-01" });
    const queue = fileInPatch(patchOf(effects), PATROL_QUEUE_PATH);
    const bullets = queue
      .split("\n")
      .filter((l) => l.startsWith("- [[wiki/entities/"));
    expect(bullets).toHaveLength(5);
    // Oldest first: e0 (2026-01-01) … e4 (2026-05-01). e5/e6 excluded.
    // Line count = 3 frontmatter lines + body: e0 has 10 body → 13; e4 has 14 → 17.
    expect(bullets[0]).toBe(
      "- [[wiki/entities/e0]] — last updated 2026-01-01, 13 lines",
    );
    expect(bullets[4]).toBe(
      "- [[wiki/entities/e4]] — last updated 2026-05-01, 17 lines",
    );
    expect(queue).not.toContain("wiki/entities/e6");
    // Header states the consolidate contract.
    expect(queue).toContain("consolidate");
    expect(queue.toLowerCase()).toContain("leave the queue");
  });

  test("scans concepts and syntheses too; pages without updated: are skipped", async () => {
    const effects = await run({
      files: {
        "wiki/concepts/c0.md": page("2026-01-01", 5),
        "wiki/syntheses/s0.md": page("2026-02-01", 5),
        // No frontmatter updated: — must be skipped from the staleness queue.
        "wiki/entities/no-date.md": "# No date\n\njust body\n",
      },
      now: "2026-07-01",
    });
    const queue = fileInPatch(patchOf(effects), PATROL_QUEUE_PATH);
    expect(queue).toContain("[[wiki/concepts/c0]]");
    expect(queue).toContain("[[wiki/syntheses/s0]]");
    expect(queue).not.toContain("no-date");
  });

  test("one PatchEffect rewrites BOTH the queue and the ledger", async () => {
    const effects = await run({
      files: { "wiki/entities/e0.md": page("2026-01-01", 5) },
      now: "2026-07-01",
    });
    const patches = effects.filter((e): e is PatchEffect => e.kind === "patch");
    expect(patches).toHaveLength(1);
    const paths = patches[0]!.changes.map((c) => String(c.path)).sort();
    expect(paths).toEqual([PATROL_LEDGER_PATH, PATROL_QUEUE_PATH]);
    // The visit is recorded in the ledger grammar.
    const ledger = fileInPatch(patches[0], PATROL_LEDGER_PATH);
    expect(ledger).toContain("- 2026-07-01 [[wiki/entities/e0]]");
  });
});

describe("dome.agent.patrol — 35-day revisit exclusion", () => {
  test("a page visited within 35 days is excluded; a page visited 40 days ago is eligible", async () => {
    // e0 is the stalest by updated:, but was visited 10 days ago → excluded.
    // e1 was visited 40 days ago → eligible again.
    const ledger = renderPatrolLedger({
      existingVisits: [
        { date: "2026-06-21", page: "wiki/entities/e0" }, // 10 days before 2026-07-01
        { date: "2026-05-22", page: "wiki/entities/e1" }, // 40 days before
      ],
      selectedPages: [],
      today: "2026-06-21",
      retentionDays: 60,
    });
    const effects = await run({
      files: {
        "wiki/entities/e0.md": page("2026-01-01", 5),
        "wiki/entities/e1.md": page("2026-02-01", 5),
        [PATROL_LEDGER_PATH]: ledger,
      },
      now: "2026-07-01",
    });
    const queue = fileInPatch(patchOf(effects), PATROL_QUEUE_PATH);
    expect(queue).not.toContain("[[wiki/entities/e0]]");
    expect(queue).toContain("[[wiki/entities/e1]]");
  });
});

describe("dome.agent.patrol — ledger retention", () => {
  test("visits older than 60 days are pruned on render", async () => {
    const effects = await run({
      files: {
        "wiki/entities/e0.md": page("2026-01-01", 5),
        [PATROL_LEDGER_PATH]: renderPatrolLedger({
          existingVisits: [
            { date: "2026-04-15", page: "wiki/entities/old" }, // 77 days before → pruned
            { date: "2026-06-15", page: "wiki/entities/recent" }, // 16 days before → kept
          ],
          selectedPages: [],
          today: "2026-06-15",
          retentionDays: 60,
        }),
      },
      now: "2026-07-01",
    });
    const ledger = fileInPatch(patchOf(effects), PATROL_LEDGER_PATH);
    expect(ledger).not.toContain("wiki/entities/old");
    expect(ledger).toContain("wiki/entities/recent");
    // tonight's visit is recorded
    expect(ledger).toContain("- 2026-07-01 [[wiki/entities/e0]]");
  });
});

describe("dome.agent.patrol — oversized-page diagnostic", () => {
  test("emits a self-clearing info diagnostic for a >600-line scanned page", async () => {
    const effects = await run({
      files: {
        "wiki/entities/huge.md": page("2026-01-01", 620), // 3 fm lines + 620 body = 623
        "wiki/entities/small.md": page("2026-02-01", 10),
      },
      now: "2026-07-01",
    });
    const diagnostics = effects.filter(
      (e): e is DiagnosticEffect => e.kind === "diagnostic",
    );
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d.severity).toBe("info");
    expect(d.code).toBe("dome.agent.page.oversized");
    // Self-clearing shape: the subject is the page path with a STABLE ref
    // (no line-number range), so the subject_hash is invariant under
    // shrinkage — resolveStaleDiagnostics clears it once the page drops
    // below the threshold and the processor stops re-emitting.
    expect(d.sourceRefs).toHaveLength(1);
    expect(String(d.sourceRefs[0]!.path)).toBe("wiki/entities/huge.md");
    expect(d.sourceRefs[0]!.range).toBeUndefined();
    // The line count rides the message (identity-free) so the nudge updates
    // without changing the subject.
    expect(d.message).toContain("623");
  });

  test("a page below the threshold emits no oversized diagnostic", async () => {
    const effects = await run({
      // 3 frontmatter lines + 500 body = 503 lines, under the 600 threshold.
      files: { "wiki/entities/e0.md": page("2026-01-01", 500) },
      now: "2026-07-01",
    });
    expect(effects.filter((e) => e.kind === "diagnostic")).toEqual([]);
  });
});

describe("dome.agent.patrol — byte-identical no-op", () => {
  test("no queue/ledger change and no oversized page → zero effects", async () => {
    // Both candidate pages were groomed within the window (excluded), the
    // queue already carries the empty-state render, and the ledger is already
    // pruned — so the fresh render is byte-identical and nothing is emitted.
    const ledger = renderPatrolLedger({
      existingVisits: [
        { date: "2026-06-25", page: "wiki/entities/e0" },
        { date: "2026-06-26", page: "wiki/entities/e1" },
      ],
      selectedPages: [],
      today: "2026-06-26",
      retentionDays: 60,
    });
    const queue = renderPatrolQueue([]);
    const effects = await run({
      files: {
        "wiki/entities/e0.md": page("2026-01-01", 10),
        "wiki/entities/e1.md": page("2026-02-01", 10),
        [PATROL_QUEUE_PATH]: queue,
        [PATROL_LEDGER_PATH]: ledger,
      },
      now: "2026-07-01",
    });
    expect(effects).toEqual([]);
  });
});

describe("parsePatrolQueue — the queue-file reader (consolidate side, Task 16)", () => {
  test("round-trips renderPatrolQueue: bullet pages parse back to their wikilink targets", () => {
    const selected = [
      { page: "wiki/entities/acme", updated: "2026-01-01", lineCount: 40 },
      { page: "wiki/concepts/liquidity", updated: "2026-02-15", lineCount: 1 },
      { page: "wiki/syntheses/q3-review", updated: "2026-03-30", lineCount: 120 },
    ];
    expect(parsePatrolQueue(renderPatrolQueue(selected))).toEqual([
      "wiki/entities/acme",
      "wiki/concepts/liquidity",
      "wiki/syntheses/q3-review",
    ]);
  });

  test("the fixed empty-state render parses to zero pages (a quiet night)", () => {
    expect(parsePatrolQueue(renderPatrolQueue([]))).toEqual([]);
  });

  test("tolerant of hand edits: the title, contract header, and blanks are ignored", () => {
    const content = [
      "# Patrol queue",
      "",
      "_Tonight's consolidate reviews these pages…_",
      "",
      "- [[wiki/entities/acme]] — last updated 2026-01-01, 40 lines",
      "some stray hand-typed note without a bullet",
      "- not a wikilink bullet",
      "- [[wiki/concepts/liquidity]] — last updated 2026-02-15, 3 lines",
      "",
    ].join("\n");
    expect(parsePatrolQueue(content)).toEqual([
      "wiki/entities/acme",
      "wiki/concepts/liquidity",
    ]);
  });

  test("empty string parses to zero pages (missing-file callers pass '')", () => {
    expect(parsePatrolQueue("")).toEqual([]);
  });
});

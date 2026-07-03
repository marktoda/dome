import { describe, expect, test } from "bun:test";

import { buildSweepQueue, safeCursor } from "../../../assets/extensions/dome.agent/lib/sweep-queue";
import { parseSweepLedger } from "../../../assets/extensions/dome.daily/processors/sweep-ledger";

const TODAY = "2026-06-10";

function files(map: Record<string, string>) {
  return {
    list: Object.keys(map),
    read: (p: string) => map[p] ?? null,
  };
}

const DEFAULTS = { windowDays: 14, targets: ["wiki/entities/", "wiki/concepts/"], maxItems: 20 };

describe("buildSweepQueue", () => {
  test("a daily wikilinking an entity yields one queue item", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]] about hooks.",
      "wiki/entities/alice-henshaw.md": "---\nsources: []\n---\n# Alice Henshaw\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toEqual([
      expect.objectContaining({
        material: "wiki/dailies/2026-06-09.md",
        destination: "wiki/entities/alice-henshaw.md",
      }),
    ]);
  });

  test("title mention without a wikilink also matches", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Long chat with Alice Henshaw about the pod.",
      "wiki/entities/alice-henshaw.md": "# Alice Henshaw\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(1);
  });

  test("settled-by-sources pairs are dropped", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md":
        '---\nsources:\n  - "[[wiki/dailies/2026-06-09]]"\n---\n# Alice Henshaw\n',
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });

  test("C1b: a ledger with ONLY an integrated row does NOT settle the pair (sources link is authoritative)", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md": "# Alice Henshaw\n", // no sources link — sub-proposal may have been rejected
    });
    const integratedOnly = parseSweepLedger(
      "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: integrated\n",
    );
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: integratedOnly });
    expect(q.items).toHaveLength(1); // re-queues: the link never landed
  });

  test("C1b: integrated row + sources link present → settles by sources, not by the ledger", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md":
        '---\nsources:\n  - "[[wiki/dailies/2026-06-09]]"\n---\n# Alice Henshaw\n',
    });
    const integratedOnly = parseSweepLedger(
      "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: integrated\n",
    );
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: integratedOnly });
    expect(q.items).toHaveLength(0);
  });

  test("settled-by-ledger pairs are dropped (no-op settles; failed does not)", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md": "# Alice Henshaw\n",
    });
    const settled = parseSweepLedger(
      "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: no-op\n",
    );
    expect(buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: settled }).items).toHaveLength(0);
    const failed = parseSweepLedger(
      "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: failed\n",
    );
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: failed });
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toEqual(expect.objectContaining({ failedCount: 1 }));
  });

  test("an escalated row settles the pair: excluded from the queue even with prior failed rows", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md": "# Alice Henshaw\n",
    });
    const escalated = parseSweepLedger(
      [
        "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: failed",
        "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: failed",
        "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: failed",
        "- [[wiki/dailies/2026-06-09]] -> [[wiki/entities/alice-henshaw]] :: escalated",
        "",
      ].join("\n"),
    );
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: escalated });
    expect(q.items).toHaveLength(0);
    // Settled means the pair also stops holding the cursor back.
    expect(q.oldestUnswept).toBeNull();
  });

  test("today's daily, pre-window dailies, and non-target links are excluded", () => {
    const vault = files({
      "wiki/dailies/2026-06-10.md": "Today: [[wiki/entities/alice-henshaw]].",
      "wiki/dailies/2026-05-01.md": "Old: [[wiki/entities/alice-henshaw]].",
      "wiki/dailies/2026-06-09.md": "See [[wiki/syntheses/something]] only.",
      "wiki/entities/alice-henshaw.md": "# Alice Henshaw\n",
      "wiki/syntheses/something.md": "# Something\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });

  test("ranking is recency-desc then mention-count-desc, and the cap reports drops", () => {
    const vault = files({
      "wiki/dailies/2026-06-08.md": "[[wiki/entities/a]]",
      "wiki/dailies/2026-06-09.md": "[[wiki/entities/b]] and [[wiki/entities/b]] twice, [[wiki/entities/c]] once.",
      "wiki/entities/a.md": "# A\n",
      "wiki/entities/b.md": "# B\n",
      "wiki/entities/c.md": "# C\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, maxItems: 2, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items.map((i) => i.destination)).toEqual(["wiki/entities/b.md", "wiki/entities/c.md"]);
    expect(q.dropped).toBe(1);
  });

  test("is deterministic", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "[[wiki/entities/a]] [[wiki/entities/b]]",
      "wiki/entities/a.md": "# A\n",
      "wiki/entities/b.md": "# B\n",
    });
    const run = () =>
      buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

// ---------------------------------------------------------------------------
// Fix 1: safe-cursor contract
// ---------------------------------------------------------------------------

describe("SweepQueue.oldestUnswept", () => {
  test("null when nothing is dropped (all items fit in cap)", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "[[wiki/entities/alice-henshaw]]",
      "wiki/entities/alice-henshaw.md": "# Alice\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger(""), maxItems: 20 });
    expect(q.oldestUnswept).toBeNull();
  });

  test("cap drops the oldest-date pair → oldestUnswept equals that date", () => {
    // Three pairs from two dates; cap at 2 drops the oldest (2026-06-07)
    const vault = files({
      "wiki/dailies/2026-06-09.md": "[[wiki/entities/alice-henshaw]] [[wiki/entities/bob-jones]]",
      "wiki/dailies/2026-06-07.md": "[[wiki/entities/carol-white]]",
      "wiki/entities/alice-henshaw.md": "# Alice\n",
      "wiki/entities/bob-jones.md": "# Bob\n",
      "wiki/entities/carol-white.md": "# Carol\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger(""), maxItems: 2 });
    // dropped = 1 (carol-white from 2026-06-07)
    expect(q.dropped).toBe(1);
    expect(q.oldestUnswept).toBe("2026-06-07");
  });
});

describe("safeCursor", () => {
  test("returns yesterday when both nulls", () => {
    expect(safeCursor({ today: "2026-06-10", oldestUnswept: null, oldestFailed: null })).toBe("2026-06-09");
  });

  test("returns dayBefore(oldestUnswept) when it is the minimum", () => {
    // oldestUnswept 2026-06-05 → dayBefore = 2026-06-04
    // oldestFailed null → yesterday = 2026-06-09
    // min = 2026-06-04
    expect(safeCursor({ today: "2026-06-10", oldestUnswept: "2026-06-05", oldestFailed: null })).toBe("2026-06-04");
  });

  test("returns dayBefore(oldestFailed) when that is older", () => {
    // oldestFailed 2026-06-03 → dayBefore = 2026-06-02
    // oldestUnswept 2026-06-05 → dayBefore = 2026-06-04
    // min = 2026-06-02
    expect(safeCursor({ today: "2026-06-10", oldestUnswept: "2026-06-05", oldestFailed: "2026-06-03" })).toBe("2026-06-02");
  });

  test("returns dayBefore(oldestFailed) when oldestUnswept is null but oldestFailed is set", () => {
    // oldestFailed 2026-06-07 → dayBefore = 2026-06-06
    // oldestUnswept null → yesterday = 2026-06-09
    // min = 2026-06-06
    expect(safeCursor({ today: "2026-06-10", oldestUnswept: null, oldestFailed: "2026-06-07" })).toBe("2026-06-06");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: word-boundary title matching
// ---------------------------------------------------------------------------

describe("word-boundary title matching", () => {
  test("'learned' does NOT match title 'earn'", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "I learned a lot today.",
      "wiki/concepts/earn.md": "# Earn\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, targets: ["wiki/concepts/"], today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });

  test("'met Earn team' DOES match title 'earn'", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "met Earn team today",
      "wiki/concepts/earn.md": "# Earn\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, targets: ["wiki/concepts/"], today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(1);
  });

  test("'Robinhood' does NOT match title 'robin'", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Robinhood stock app.",
      "wiki/entities/robin.md": "# Robin\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3: settlement accepts display-text and .md-suffixed sources entries
// ---------------------------------------------------------------------------

describe("isSettledBySources — display-text and .md-suffixed wikilinks", () => {
  test("[[material|display text]] settles the pair", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md":
        '---\nsources:\n  - "[[wiki/dailies/2026-06-09|Jun 9]]"\n---\n# Alice\n',
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });

  test("[[material.md]] settles the pair", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md":
        '---\nsources:\n  - "[[wiki/dailies/2026-06-09.md]]"\n---\n# Alice\n',
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });

  test("[[material.md|display text]] settles the pair", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md":
        '---\nsources:\n  - "[[wiki/dailies/2026-06-09.md|Jun 9]]"\n---\n# Alice\n',
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 4a: frontmatter tolerance — leading blank lines
// ---------------------------------------------------------------------------

describe("frontmatter tolerance — leading blank lines", () => {
  test("leading blank lines before opening --- do not defeat settlement", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "Met [[wiki/entities/alice-henshaw]].",
      "wiki/entities/alice-henshaw.md":
        '\n\n---\nsources:\n  - "[[wiki/dailies/2026-06-09]]"\n---\n# Alice\n',
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 4c: short-link hyphenated basename matching
// ---------------------------------------------------------------------------

describe("short-link hyphenated basename matching", () => {
  test("body '[[alice-henshaw]]' (bare basename, no path) surfaces the pair", () => {
    const vault = files({
      "wiki/dailies/2026-06-09.md": "talked to [[alice-henshaw]] today",
      "wiki/entities/alice-henshaw.md": "# Alice Henshaw\n",
    });
    const q = buildSweepQueue({ ...DEFAULTS, ...vault, today: TODAY, ledger: parseSweepLedger("") });
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toEqual(expect.objectContaining({
      material: "wiki/dailies/2026-06-09.md",
      destination: "wiki/entities/alice-henshaw.md",
    }));
  });
});

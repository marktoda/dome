import { describe, expect, test } from "bun:test";

import { buildSweepQueue } from "../../../assets/extensions/dome.agent/lib/sweep-queue";
import { parseSweepLedger } from "../../../assets/extensions/dome.agent/lib/sweep-ledger";

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

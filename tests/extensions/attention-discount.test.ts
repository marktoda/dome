import { describe, expect, test } from "bun:test";

import attentionDiscount from "../../assets/extensions/dome.daily/processors/attention-discount";
import {
  ATTENTION_DISCOUNT_CAP,
  ATTENTION_DISCOUNT_PREDICATE,
  attentionAdjustedRecencyIso,
  attentionAdjustedRecencyMs,
  attentionDiscountValue,
  collectAttentionDiscounts,
  isAttentionExemptBody,
  parseAttentionDiscountFactValue,
} from "../../assets/extensions/dome.daily/processors/attention-shared";
import type { FactEffect } from "../../src/core/effect";
import { makeManualProposal } from "../../src/core/proposal";
import { requireVaultPath } from "../../src/core/vault-path";
import { commitOid } from "../../src/core/source-ref";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("4444444444444444444444444444444444444444");

// ----- formula edges ---------------------------------------------------------

describe("attentionDiscountValue", () => {
  test("first two impressions are free", () => {
    for (const impressions of [0, 1, 2]) {
      expect(
        attentionDiscountValue({
          impressions,
          daysSinceLastShown: 0,
          exempt: false,
        }),
      ).toBe(0);
    }
  });

  test("grows 0.1 per impression beyond the free two", () => {
    expect(
      attentionDiscountValue({
        impressions: 3,
        daysSinceLastShown: 0,
        exempt: false,
      }),
    ).toBeCloseTo(0.1, 10);
    expect(
      attentionDiscountValue({
        impressions: 5,
        daysSinceLastShown: 0,
        exempt: false,
      }),
    ).toBeCloseTo(0.3, 10);
  });

  test("hard cap at 0.6", () => {
    expect(
      attentionDiscountValue({
        impressions: 8,
        daysSinceLastShown: 0,
        exempt: false,
      }),
    ).toBe(ATTENTION_DISCOUNT_CAP);
    expect(
      attentionDiscountValue({
        impressions: 50,
        daysSinceLastShown: 0,
        exempt: false,
      }),
    ).toBe(ATTENTION_DISCOUNT_CAP);
  });

  test("decays 0.9 per day since last shown (self-healing recovery)", () => {
    expect(
      attentionDiscountValue({
        impressions: 5,
        daysSinceLastShown: 1,
        exempt: false,
      }),
    ).toBeCloseTo(0.27, 10);
    expect(
      attentionDiscountValue({
        impressions: 5,
        daysSinceLastShown: 2,
        exempt: false,
      }),
    ).toBeCloseTo(0.243, 10);
    // Long-unshown items recover to ~nothing.
    expect(
      attentionDiscountValue({
        impressions: 50,
        daysSinceLastShown: 60,
        exempt: false,
      }),
    ).toBeLessThan(0.002);
  });

  test("negative day deltas clamp to no decay", () => {
    expect(
      attentionDiscountValue({
        impressions: 5,
        daysSinceLastShown: -3,
        exempt: false,
      }),
    ).toBeCloseTo(0.3, 10);
  });

  test("exempt items always discount to 0", () => {
    expect(
      attentionDiscountValue({
        impressions: 20,
        daysSinceLastShown: 0,
        exempt: true,
      }),
    ).toBe(0);
  });
});

describe("isAttentionExemptBody", () => {
  test("due date and top priority exempt; lower priorities do not", () => {
    expect(isAttentionExemptBody("ship the thing 📅 2026-06-12")).toBe(true);
    expect(isAttentionExemptBody("ship the thing 🔺")).toBe(true);
    expect(isAttentionExemptBody("ship the thing ⏫")).toBe(false);
    expect(isAttentionExemptBody("ship the thing")).toBe(false);
    expect(isAttentionExemptBody("calendar emoji alone 📅 someday")).toBe(false);
  });
});

describe("attentionAdjustedRecencyMs / Iso", () => {
  const at = "2026-06-09T09:00:00.000Z";

  test("discount 0 is the identity", () => {
    expect(attentionAdjustedRecencyMs({ lastChangedAt: at, discount: 0 })).toBe(
      Date.parse(at),
    );
    expect(attentionAdjustedRecencyIso({ lastChangedAt: at, discount: 0 })).toBe(
      at,
    );
  });

  test("demotion is monotone in the discount and equals log(1−d)/log(0.995) hours", () => {
    const d03 = attentionAdjustedRecencyMs({ lastChangedAt: at, discount: 0.3 });
    const d06 = attentionAdjustedRecencyMs({ lastChangedAt: at, discount: 0.6 });
    expect(d03).toBeLessThan(Date.parse(at));
    expect(d06).toBeLessThan(d03);
    const hours03 = (Date.parse(at) - d03) / 3_600_000;
    expect(hours03).toBeCloseTo(Math.log(1 - 0.3) / Math.log(0.995), 6);
  });

  test("unparseable timestamps sort last", () => {
    expect(attentionAdjustedRecencyMs({ lastChangedAt: "", discount: 0.5 })).toBe(
      Number.MIN_SAFE_INTEGER,
    );
    expect(attentionAdjustedRecencyIso({ lastChangedAt: "", discount: 0.5 })).toBe(
      "",
    );
  });
});

// ----- collectAttentionDiscounts ---------------------------------------------

const ALPHA_PATH = "wiki/projects/alpha.md";
const ALPHA_TASK = "- [ ] #task Send budget update ^t1a2b3c4d";
const ALPHA_BODY = "Send budget update";

function dailyWithLoops(date: string, copies: ReadonlyArray<string>): string {
  return [
    `# ${date}`,
    "",
    "## Open Loops",
    "",
    "<!-- dome.daily:open-loops:start -->",
    "### Source-backed Open Loops",
    ...copies,
    "<!-- dome.daily:open-loops:end -->",
    "",
  ].join("\n");
}

function alphaCopy(body = ALPHA_BODY): string {
  return `- [ ] ${body} (from [[wiki/projects/alpha]])`;
}

function fakeSnapshot(opts: {
  readonly files: Record<string, string>;
  readonly lastHumanChangedAt?: Record<string, string | null>;
}): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("5555555555555555555555555555555555555555"),
    readFile: async (p: string) => opts.files[p] ?? null,
    listMarkdownFiles: async () => Object.freeze(Object.keys(opts.files)),
    getFileInfo: async (p: string) => {
      if (!(p in opts.files)) return null;
      const human = opts.lastHumanChangedAt?.[p];
      return Object.freeze({
        lastChangedCommit: HEAD_COMMIT,
        lastChangedAt: "2026-06-09T12:00:00.000Z",
        lastHumanChangedAt: human === undefined ? null : human,
      });
    },
  });
}

describe("collectAttentionDiscounts", () => {
  test("counts distinct dailies, tracks lastShown, applies the formula", async () => {
    const snapshot = fakeSnapshot({
      files: {
        [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n`,
        "wiki/dailies/2026-06-05.md": dailyWithLoops("2026-06-05", [alphaCopy()]),
        "wiki/dailies/2026-06-06.md": dailyWithLoops("2026-06-06", [alphaCopy()]),
        "wiki/dailies/2026-06-07.md": dailyWithLoops("2026-06-07", [alphaCopy()]),
        "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", [alphaCopy()]),
        "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [alphaCopy()]),
      },
    });
    const discounts = await collectAttentionDiscounts({ snapshot });
    expect(discounts.size).toBe(1);
    const entry = [...discounts.values()][0]!;
    expect(entry.sourcePath).toBe(ALPHA_PATH);
    expect(entry.anchor).toBe("t1a2b3c4d");
    expect(entry.impressions).toBe(5);
    expect(entry.lastShown).toBe("2026-06-09");
    expect(entry.daysSinceLastShown).toBe(0);
    expect(entry.exempt).toBe(false);
    expect(entry.discount).toBeCloseTo(0.3, 10);
  });

  test("recovery: an item no longer shown decays with the days since lastShown", async () => {
    const snapshot = fakeSnapshot({
      files: {
        [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n`,
        // Shown 5x through 06-05, then never again while dailies advance.
        "wiki/dailies/2026-06-01.md": dailyWithLoops("2026-06-01", [alphaCopy()]),
        "wiki/dailies/2026-06-02.md": dailyWithLoops("2026-06-02", [alphaCopy()]),
        "wiki/dailies/2026-06-03.md": dailyWithLoops("2026-06-03", [alphaCopy()]),
        "wiki/dailies/2026-06-04.md": dailyWithLoops("2026-06-04", [alphaCopy()]),
        "wiki/dailies/2026-06-05.md": dailyWithLoops("2026-06-05", [alphaCopy()]),
        "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", []),
        "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", []),
      },
    });
    const entry = [...(await collectAttentionDiscounts({ snapshot })).values()][0]!;
    expect(entry.impressions).toBe(5);
    expect(entry.lastShown).toBe("2026-06-05");
    expect(entry.daysSinceLastShown).toBe(4);
    expect(entry.discount).toBeCloseTo(0.3 * 0.9 ** 4, 4);
  });

  test("a human touch resets the impression trail (only later dailies count)", async () => {
    const snapshot = fakeSnapshot({
      files: {
        [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n`,
        "wiki/dailies/2026-06-05.md": dailyWithLoops("2026-06-05", [alphaCopy()]),
        "wiki/dailies/2026-06-06.md": dailyWithLoops("2026-06-06", [alphaCopy()]),
        "wiki/dailies/2026-06-07.md": dailyWithLoops("2026-06-07", [alphaCopy()]),
        "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", [alphaCopy()]),
        "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [alphaCopy()]),
      },
      lastHumanChangedAt: { [ALPHA_PATH]: "2026-06-07T16:30:00.000Z" },
    });
    const entry = [...(await collectAttentionDiscounts({ snapshot })).values()][0]!;
    // Only 06-08 and 06-09 are strictly after the touch date — free again.
    expect(entry.impressions).toBe(2);
    expect(entry.discount).toBe(0);
  });

  test("exempt bodies (📅 / 🔺) keep impressions but discount 0", async () => {
    const task = "- [ ] #task Pay invoices 🔺 ^tfeedf00d";
    const copy = "- [ ] Pay invoices 🔺 (from [[wiki/projects/alpha]])";
    const snapshot = fakeSnapshot({
      files: {
        [ALPHA_PATH]: `# Alpha\n\n${task}\n`,
        "wiki/dailies/2026-06-05.md": dailyWithLoops("2026-06-05", [copy]),
        "wiki/dailies/2026-06-06.md": dailyWithLoops("2026-06-06", [copy]),
        "wiki/dailies/2026-06-07.md": dailyWithLoops("2026-06-07", [copy]),
        "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", [copy]),
        "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [copy]),
      },
    });
    const entry = [...(await collectAttentionDiscounts({ snapshot })).values()][0]!;
    expect(entry.exempt).toBe(true);
    expect(entry.impressions).toBe(5);
    expect(entry.discount).toBe(0);
  });

  test("settled items get no entry (cleanup)", async () => {
    const snapshot = fakeSnapshot({
      files: {
        [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n`,
        "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", [alphaCopy()]),
        "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [
          `- [x] ${ALPHA_BODY} (from [[wiki/projects/alpha]])`,
        ]),
      },
    });
    expect((await collectAttentionDiscounts({ snapshot })).size).toBe(0);
  });

  test("unanchored origin lines do not participate", async () => {
    const snapshot = fakeSnapshot({
      files: {
        [ALPHA_PATH]: "# Alpha\n\n- [ ] #task Send budget update\n",
        "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", [alphaCopy()]),
        "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [alphaCopy()]),
      },
    });
    expect((await collectAttentionDiscounts({ snapshot })).size).toBe(0);
  });

  test("scan is bounded to the most recent 30 dailies", async () => {
    const files: Record<string, string> = {
      [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n`,
      // Shown only in an old daily that falls outside the 30-day window.
      "wiki/dailies/2026-04-01.md": dailyWithLoops("2026-04-01", [alphaCopy()]),
    };
    for (let day = 1; day <= 30; day += 1) {
      const date = `2026-06-${String(day).padStart(2, "0")}`;
      files[`wiki/dailies/${date}.md`] = dailyWithLoops(date, []);
    }
    const snapshot = fakeSnapshot({ files });
    expect((await collectAttentionDiscounts({ snapshot })).size).toBe(0);
  });

  test("no dailies → empty map", async () => {
    const snapshot = fakeSnapshot({
      files: { [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n` },
    });
    expect((await collectAttentionDiscounts({ snapshot })).size).toBe(0);
  });
});

// ----- the processor ----------------------------------------------------------

describe("dome.daily.attention-discount", () => {
  const files = {
    [ALPHA_PATH]: `# Alpha\n\n${ALPHA_TASK}\n`,
    "wiki/dailies/2026-06-05.md": dailyWithLoops("2026-06-05", [alphaCopy()]),
    "wiki/dailies/2026-06-06.md": dailyWithLoops("2026-06-06", [alphaCopy()]),
    "wiki/dailies/2026-06-07.md": dailyWithLoops("2026-06-07", [alphaCopy()]),
    "wiki/dailies/2026-06-08.md": dailyWithLoops("2026-06-08", [alphaCopy()]),
    "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [alphaCopy()]),
  };

  async function run(snapshot: Snapshot) {
    const ctx = makeProcessorContext({
      snapshot,
      changedPaths: Object.keys(files),
      proposal: makeManualProposal({
        base: HEAD_COMMIT,
        head: HEAD_COMMIT,
        branch: "main",
      }),
      runId: "run-attention-discount",
      signal: new AbortController().signal,
      input: { kind: "garden", matchedTriggers: [] } as unknown,
    });
    return attentionDiscount.run(ctx);
  }

  test("emits one dome.attention.discount fact per discounted item", async () => {
    const effects = await run(fakeSnapshot({ files }));
    expect(effects.length).toBe(1);
    const fact = effects[0] as FactEffect;
    expect(fact.kind).toBe("fact");
    expect(fact.predicate).toBe(ATTENTION_DISCOUNT_PREDICATE);
    expect(fact.subject).toEqual({
      kind: "page",
      path: requireVaultPath(ALPHA_PATH),
    });
    expect(fact.assertion).toBe("extracted");
    expect(fact.sourceRefs[0]?.path).toBe(requireVaultPath(ALPHA_PATH));
    expect(fact.sourceRefs[0]?.stableId).toBe(
      "dome.daily.open-loop:t1a2b3c4d",
    );
    const value =
      fact.object.kind === "string"
        ? parseAttentionDiscountFactValue(fact.object.value)
        : null;
    expect(value).toEqual({
      anchor: "t1a2b3c4d",
      body: ALPHA_BODY,
      discount: 0.3,
      impressions: 5,
      lastShown: "2026-06-09",
    });
  });

  test("idempotent: a re-run over the same snapshot emits identical facts", async () => {
    const first = await run(fakeSnapshot({ files }));
    const second = await run(fakeSnapshot({ files }));
    expect(second).toEqual(first);
  });

  test("settled items emit no facts", async () => {
    const settled = {
      ...files,
      "wiki/dailies/2026-06-09.md": dailyWithLoops("2026-06-09", [
        `- [-] ${ALPHA_BODY} (from [[wiki/projects/alpha]])`,
      ]),
    };
    expect(await run(fakeSnapshot({ files: settled }))).toEqual([]);
  });
});

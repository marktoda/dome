// scenarios/cli-surface/attention-discount.scenario.test.ts
//
// Attention discounting end-to-end (memory-quality M4, task-lifecycle.md
// §"Attention discounting"): an open loop carried forward across synthetic
// dailies without action accrues a discount, the carry-forward / today
// ranking demotes it (visible in `dome run today --json` with an explainable
// attention note), a human edit to the origin file resets the trail, 📅/🔺
// items are exempt, and settling an item clears its facts.

import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { TestClock, scenario } from "../../index";

const AUTHOR = { name: "dome-test", email: "test@local" };

function ts(iso: string): number {
  return Date.parse(iso) / 1000;
}

scenario(
  {
    name: "cli-surface: attention discount grows across untouched dailies, demotes ranking, and self-heals on a human touch",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "schedule" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "garden-signal" },
      { kind: "route", route: "garden-schedule" },
    ],
    harness: {
      clock: new TestClock("2026-06-01T15:00:00.000Z"),
      bundles: ["dome.daily"],
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // Alpha: committed on day 1. Its impression trail starts the next day
    // (dailies dated strictly after the touch date count).
    await h.userCommit({
      files: {
        "wiki/projects/alpha.md": [
          "# Alpha",
          "",
          "TODO: Send budget update",
          "",
        ].join("\n"),
      },
      message: "add alpha loop",
      author: { ...AUTHOR, timestamp: ts("2026-06-01T12:00:00.000Z") },
    });
    expect((await h.tick()).adopted).toBe(true);

    // Days 2–3: alpha carried forward, untouched — still inside the two free
    // impressions.
    for (const _ of [1, 2]) {
      await h.advance(24 * 60 * 60 * 1000);
      expect((await h.tick()).adopted).toBe(true);
    }

    // Day 4: beta arrives, slightly OLDER by human-edit recency (backdated
    // author timestamp) — so without discounting alpha ranks first.
    await h.advance(24 * 60 * 60 * 1000);
    await h.userCommit({
      files: {
        "wiki/projects/beta.md": [
          "# Beta",
          "",
          "TODO: Review beta launch",
          "",
        ].join("\n"),
      },
      message: "add beta loop",
      author: { ...AUTHOR, timestamp: ts("2026-06-01T06:00:00.000Z") },
    });
    expect((await h.tick()).adopted).toBe(true);

    const day4 = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-06-04.md"),
      "utf8",
    );
    // Alpha (newer human edit, discount still 0) outranks beta on day 4.
    expect(day4.indexOf("Send budget update")).toBeGreaterThan(0);
    expect(day4.indexOf("Send budget update")).toBeLessThan(
      day4.indexOf("Review beta launch"),
    );

    // Day 5: alpha has now been shown 4x since its last human touch — the
    // discount demotes it below the older-but-unshown beta.
    await h.advance(24 * 60 * 60 * 1000);
    expect((await h.tick()).adopted).toBe(true);

    const day5 = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-06-05.md"),
      "utf8",
    );
    expect(day5.indexOf("Review beta launch")).toBeGreaterThan(0);
    expect(day5.indexOf("Review beta launch")).toBeLessThan(
      day5.indexOf("Send budget update"),
    );

    // The deterministic facts are in the projection (rebuildable substrate).
    await h
      .expectProjection()
      .facts({
        predicate: "dome.attention.discount",
        subjectId: "wiki/projects/alpha.md",
      })
      .toHaveCount(1);

    // Explainable note + demoted order, visible in `dome run today --json`.
    const json = await h.runCli([
      "run",
      "today",
      "--date",
      "2026-06-05",
      "--json",
    ]);
    expect(json.exitCode).toBe(0);
    const payload = structuredData(json.stdout) as {
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly attention: {
          readonly discount: number;
          readonly impressions: number;
          readonly lastShown: string;
        } | null;
      }>;
    };
    const texts = payload.openTasks.map((task) => task.text);
    expect(texts.indexOf("Review beta launch")).toBeLessThan(
      texts.indexOf("Send budget update"),
    );
    const alpha = payload.openTasks.find(
      (task) => task.text === "Send budget update",
    );
    expect(alpha?.attention).toEqual({
      discount: 0.2,
      impressions: 4,
      lastShown: "2026-06-05",
    });
    const beta = payload.openTasks.find(
      (task) => task.text === "Review beta launch",
    );
    expect(beta?.attention?.discount).toBe(0);

    // agenda-with mirrors today/prep (task-lifecycle §"Attention
    // discounting"): demoted ordering inherited from the shared action
    // state plus the same explainable attention field per JSON row. The
    // single-letter topic is a substring match that catches both tasks.
    const agenda = structuredData(
      (
        await h.runCli([
          "run",
          "agenda-with",
          "u",
          "--date",
          "2026-06-05",
          "--json",
        ])
      ).stdout,
    ) as {
      readonly agendaItems: ReadonlyArray<{
        readonly text: string;
        readonly attention: {
          readonly discount: number;
          readonly impressions: number;
          readonly lastShown: string;
        } | null;
      }>;
    };
    const agendaTexts = agenda.agendaItems.map((item) => item.text);
    expect(agendaTexts).toContain("Send budget update");
    expect(agendaTexts).toContain("Review beta launch");
    expect(agendaTexts.indexOf("Review beta launch")).toBeLessThan(
      agendaTexts.indexOf("Send budget update"),
    );
    expect(
      agenda.agendaItems.find((item) => item.text === "Send budget update")
        ?.attention,
    ).toEqual({
      discount: 0.2,
      impressions: 4,
      lastShown: "2026-06-05",
    });
    expect(
      agenda.agendaItems.find((item) => item.text === "Review beta launch")
        ?.attention?.discount,
    ).toBe(0);

    // Idempotent: a re-tick rewrites nothing.
    const before = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-06-05.md"),
      "utf8",
    );
    expect((await h.tick()).adopted).toBe(true);
    expect(
      await readFile(join(h.vaultPath, "wiki/dailies/2026-06-05.md"), "utf8"),
    ).toBe(before);

    // Day 6 + a human edit to alpha's origin file (task line untouched):
    // the impression trail resets — discount facts vanish, attention is null.
    await h.advance(24 * 60 * 60 * 1000);
    expect((await h.tick()).adopted).toBe(true);
    const alphaContent = await readFile(
      join(h.vaultPath, "wiki/projects/alpha.md"),
      "utf8",
    );
    await h.userCommit({
      files: {
        "wiki/projects/alpha.md": `${alphaContent}\nTouched the project plan today.\n`,
      },
      message: "human touch on alpha",
      author: { ...AUTHOR, timestamp: ts("2026-06-06T12:00:00.000Z") },
    });
    expect((await h.tick()).adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.attention.discount",
        subjectId: "wiki/projects/alpha.md",
      })
      .toHaveCount(0);
    const afterTouch = structuredData(
      (await h.runCli(["run", "today", "--date", "2026-06-06", "--json"]))
        .stdout,
    ) as {
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly attention: { readonly discount: number } | null;
      }>;
    };
    expect(
      afterTouch.openTasks.find((task) => task.text === "Send budget update")
        ?.attention,
    ).toBe(null);

    // Day 7's fresh daily ranks alpha first again — demotion self-healed.
    await h.advance(24 * 60 * 60 * 1000);
    expect((await h.tick()).adopted).toBe(true);
    const day7 = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-06-07.md"),
      "utf8",
    );
    expect(day7.indexOf("Send budget update")).toBeGreaterThan(0);
    expect(day7.indexOf("Send budget update")).toBeLessThan(
      day7.indexOf("Review beta launch"),
    );
  },
);

scenario(
  {
    name: "cli-surface: attention discount exempts 📅/🔺 items and clears facts when an item settles",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "fact" },
      { kind: "effect", effect: "patch" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "garden" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "read" },
      { kind: "capability", capability: "graph.write" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
      { kind: "route", route: "garden-signal" },
    ],
    harness: {
      clock: new TestClock("2026-06-05T15:00:00.000Z"),
      bundles: ["dome.daily"],
      initialFiles: {
        // Five synthetic dailies whose generated open-loops blocks carried
        // both items every day.
        ...Object.fromEntries(
          ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]
            .map((date) => [
              `wiki/dailies/${date}.md`,
              [
                `# ${date}`,
                "",
                "## Open Loops",
                "",
                "<!-- dome.daily:open-loops:start -->",
                "### Source-backed Open Loops",
                "- [ ] Draft the migration plan (from [[wiki/projects/omega]])",
                "- [ ] Pay the invoices 🔺 (from [[wiki/projects/omega]])",
                "<!-- dome.daily:open-loops:end -->",
                "",
                "## Notes",
                "",
              ].join("\n"),
            ]),
        ),
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    // Origin committed with an old human timestamp so every shown daily
    // counts. Lines are pre-anchored (anchored identity is required).
    await h.userCommit({
      files: {
        "wiki/projects/omega.md": [
          "# Omega",
          "",
          "- [ ] #task Draft the migration plan ^t11111111",
          "- [ ] #task Pay the invoices 🔺 ^t22222222",
          "",
        ].join("\n"),
      },
      message: "add omega loops",
      author: { ...AUTHOR, timestamp: ts("2026-05-25T12:00:00.000Z") },
    });
    expect((await h.tick()).adopted).toBe(true);

    // Both items carry facts (both were shown); only the plain one discounts.
    await h
      .expectProjection()
      .facts({
        predicate: "dome.attention.discount",
        subjectId: "wiki/projects/omega.md",
      })
      .toHaveCount(2);

    const payload = structuredData(
      (await h.runCli(["run", "today", "--date", "2026-06-05", "--json"]))
        .stdout,
    ) as {
      readonly openTasks: ReadonlyArray<{
        readonly text: string;
        readonly attention: {
          readonly discount: number;
          readonly impressions: number;
        } | null;
      }>;
    };
    const plain = payload.openTasks.find(
      (task) => task.text === "Draft the migration plan",
    );
    const exempt = payload.openTasks.find(
      (task) => task.text === "Pay the invoices",
    );
    expect(plain?.attention?.discount ?? 0).toBeGreaterThan(0);
    expect(plain?.attention?.impressions ?? 0).toBeGreaterThanOrEqual(5);
    // 🔺 exemption: shown just as often, discounted 0.
    expect(exempt?.attention?.impressions ?? 0).toBeGreaterThanOrEqual(5);
    expect(exempt?.attention?.discount).toBe(0);

    // PROJECTIONS_ARE_REBUILDABLE: the discount facts are clock-free and
    // re-derive from adopted markdown + git history — `dome rebuild`
    // (which re-runs the deterministic rebuild-eligible garden set)
    // restores both rows.
    const rebuild = await h.runCli(["rebuild", "--json"]);
    expect(rebuild.exitCode).toBe(0);
    await h
      .expectProjection()
      .facts({
        predicate: "dome.attention.discount",
        subjectId: "wiki/projects/omega.md",
      })
      .toHaveCount(2);

    // Settling the plain item (resolve its surfaced copy) clears its fact.
    const daily = await readFile(
      join(h.vaultPath, "wiki/dailies/2026-06-05.md"),
      "utf8",
    );
    await h.userCommit({
      files: {
        "wiki/dailies/2026-06-05.md": daily.replace(
          "- [ ] Draft the migration plan (from [[wiki/projects/omega]])",
          "- [x] Draft the migration plan (from [[wiki/projects/omega]])",
        ),
      },
      message: "settle the migration plan loop",
    });
    expect((await h.tick()).adopted).toBe(true);

    await h
      .expectProjection()
      .facts({
        predicate: "dome.attention.discount",
        subjectId: "wiki/projects/omega.md",
      })
      .toHaveCount(1);
  },
);

function structuredData(stdout: string): unknown {
  const envelope = JSON.parse(stdout) as { readonly data?: unknown };
  return envelope.data;
}

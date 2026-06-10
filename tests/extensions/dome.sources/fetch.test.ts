// dome.sources.fetch — the subscription scheduler (wiki/specs/sources.md).
//
// Pins the processor's stateless contract: due-ness from (cron, firedAt)
// against a fully controllable clock, skip-if-present from the adopted
// snapshot, the (kind, date) idempotency key, the explicit-consent rule
// (`enabled` must be EXACTLY true), and the fallback-not-crash config
// temperament (malformed entries skip with one info diagnostic; disabled
// or absent subscriptions are silent — disabled is a state, not a problem).

import { describe, expect, test } from "bun:test";

import fetchProcessor, {
  fetchIdempotencyKey,
  isDueToday,
  localDateOf,
  outputPathTemplateProblem,
  renderOutputPath,
  resolveSubscriptions,
} from "../../../assets/extensions/dome.sources/processors/fetch";
import type {
  DiagnosticEffect,
  Effect,
  ExternalActionEffect,
} from "../../../src/core/effect";
import { makeManualProposal } from "../../../src/core/proposal";
import { commitOid } from "../../../src/core/source-ref";
import { treeOid, type Snapshot } from "../../../src/core/processor";
import { makeProcessorContext } from "../../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");

// 2026-06-10 is a Wednesday. All fire times are constructed as LOCAL wall
// clock (the processor derives periods from vault-local days), so the tests
// are deterministic in any timezone.
const WEDNESDAY = { y: 2026, m: 5, d: 10 } as const;

function localTime(hour: number, minute: number): Date {
  return new Date(WEDNESDAY.y, WEDNESDAY.m, WEDNESDAY.d, hour, minute, 0, 0);
}

const CALENDAR = {
  enabled: true,
  schedule: "10 5 * * *",
  output_path: "sources/calendar/{date}.md",
  command: ["sh", ".dome/bin/fetch-calendar.sh"],
} as const;

describe("dome.sources.fetch due-ness (controllable clock)", () => {
  test("due once the cron's first fire of the local day has passed", () => {
    expect(isDueToday("10 5 * * *", localTime(5, 10))).toBe(true);
    expect(isDueToday("10 5 * * *", localTime(5, 15))).toBe(true);
    expect(isDueToday("10 5 * * *", localTime(23, 59))).toBe(true);
  });

  test("not due before today's first fire", () => {
    expect(isDueToday("10 5 * * *", localTime(0, 0))).toBe(false);
    expect(isDueToday("10 5 * * *", localTime(5, 9))).toBe(false);
  });

  test("a schedule that does not fire today at all is not due (no backfill)", () => {
    // Monday-only cron checked on a Wednesday.
    expect(isDueToday("0 9 * * 1", localTime(12, 0))).toBe(false);
    // Wednesday cron on the same Wednesday is due after 09:00.
    expect(isDueToday("0 9 * * 3", localTime(12, 0))).toBe(true);
  });

  test("a midnight cron is due from midnight itself", () => {
    expect(isDueToday("0 0 * * *", localTime(0, 0))).toBe(true);
  });

  test("an unparseable cron is never due (the problem path reports it)", () => {
    expect(isDueToday("not a cron", localTime(12, 0))).toBe(false);
  });
});

describe("dome.sources.fetch period helpers", () => {
  test("the period key is the vault-local YYYY-MM-DD of the fire", () => {
    expect(localDateOf(localTime(5, 15))).toBe("2026-06-10");
  });

  test("the idempotency key is (kind, date) scoped under dome.sources", () => {
    expect(fetchIdempotencyKey("calendar", "2026-06-10")).toBe(
      "dome.sources:calendar:2026-06-10",
    );
  });

  test("output_path templates render {date} everywhere it appears", () => {
    expect(
      renderOutputPath("sources/calendar/{date}.md", "2026-06-10"),
    ).toBe("sources/calendar/2026-06-10.md");
  });

  test("output_path template validation rejects escape shapes", () => {
    expect(outputPathTemplateProblem("sources/calendar/{date}.md")).toBeNull();
    expect(outputPathTemplateProblem("sources/calendar/today.md")).toContain(
      "{date}",
    );
    expect(outputPathTemplateProblem("sources/{date}.txt")).toContain(".md");
    expect(outputPathTemplateProblem("/abs/{date}.md")).toContain("relative");
    expect(outputPathTemplateProblem("a\\b/{date}.md")).toContain("relative");
    expect(outputPathTemplateProblem("../up/{date}.md")).toContain("'..'");
    expect(outputPathTemplateProblem("a//b/{date}.md")).toContain("empty");
    expect(outputPathTemplateProblem(" padded/{date}.md ")).toContain(
      "whitespace",
    );
  });
});

describe("dome.sources.fetch config resolution (consent + temperament)", () => {
  test("absent config and absent subscriptions are silent", () => {
    expect(resolveSubscriptions(undefined)).toEqual({
      subscriptions: [],
      problems: [],
    });
    expect(resolveSubscriptions({})).toEqual({
      subscriptions: [],
      problems: [],
    });
  });

  test("enabled must be EXACTLY true — false, absent, and junk are silently inert", () => {
    const resolved = resolveSubscriptions({
      subscriptions: {
        off: { ...CALENDAR, enabled: false },
        absent: { schedule: "10 5 * * *", output_path: "s/{date}.md", command: ["x"] },
        junk: { ...CALENDAR, enabled: "yes" },
      },
    });
    expect(resolved.subscriptions).toEqual([]);
    expect(resolved.problems).toEqual([]);
  });

  test("a malformed subscriptions mapping degrades to one problem, never a throw", () => {
    const resolved = resolveSubscriptions({ subscriptions: ["nope"] });
    expect(resolved.subscriptions).toEqual([]);
    expect(resolved.problems.length).toBe(1);
    expect(resolved.problems[0]).toContain("mapping");
  });

  test("each malformed entry is skipped with a problem; well-formed siblings survive", () => {
    const resolved = resolveSubscriptions({
      subscriptions: {
        calendar: { ...CALENDAR },
        "BAD KIND": { ...CALENDAR },
        scalar: 7,
        badcron: { ...CALENDAR, schedule: "every day at five" },
        badpath: { ...CALENDAR, output_path: "sources/calendar/today.md" },
        badcommand: { ...CALENDAR, command: [] },
        badcommandtype: { ...CALENDAR, command: ["sh", 5] },
      },
    });
    expect(resolved.subscriptions.map((s) => s.kind)).toEqual(["calendar"]);
    expect(resolved.problems.length).toBe(6);
    expect(resolved.problems.join("\n")).toContain('"BAD KIND"');
    expect(resolved.problems.join("\n")).toContain('"scalar"');
    expect(resolved.problems.join("\n")).toContain('"badcron"');
    expect(resolved.problems.join("\n")).toContain('"badpath"');
    expect(resolved.problems.join("\n")).toContain('"badcommand"');
    expect(resolved.problems.join("\n")).toContain('"badcommandtype"');
  });
});

describe("dome.sources.fetch processor runs", () => {
  test("due + absent emits one external effect with the (kind, date) idempotency key", async () => {
    const effects = await runFetch({
      firedAt: localTime(5, 15),
      config: { subscriptions: { calendar: { ...CALENDAR } } },
      presentFiles: [],
    });

    expect(effects.length).toBe(1);
    const effect = expectExternal(effects, 0);
    expect(effect.capability).toBe("sources.fetch");
    expect(effect.idempotencyKey).toBe("dome.sources:calendar:2026-06-10");
    expect(effect.payload).toEqual({
      kind: "calendar",
      date: "2026-06-10",
      output_path: "sources/calendar/2026-06-10.md",
      command: ["sh", ".dome/bin/fetch-calendar.sh"],
    });
    expect(effect.sourceRefs.length).toBe(1);
  });

  test("re-running the same tick emits the identical key (stateless retry pump)", async () => {
    const run = () =>
      runFetch({
        firedAt: localTime(6, 0),
        config: { subscriptions: { calendar: { ...CALENDAR } } },
        presentFiles: [],
      });
    const first = await run();
    const second = await run();
    expect(expectExternal(first, 0).idempotencyKey).toBe(
      expectExternal(second, 0).idempotencyKey,
    );
  });

  test("not yet due emits nothing", async () => {
    const effects = await runFetch({
      firedAt: localTime(4, 0),
      config: { subscriptions: { calendar: { ...CALENDAR } } },
      presentFiles: [],
    });
    expect(effects).toEqual([]);
  });

  test("skip-if-present: an adopted output file (or hand-written agenda) wins", async () => {
    const effects = await runFetch({
      firedAt: localTime(5, 15),
      config: { subscriptions: { calendar: { ...CALENDAR } } },
      presentFiles: ["sources/calendar/2026-06-10.md"],
    });
    expect(effects).toEqual([]);
  });

  test("disabled subscription is silent — no effect, no diagnostic", async () => {
    const effects = await runFetch({
      firedAt: localTime(5, 15),
      config: {
        subscriptions: { calendar: { ...CALENDAR, enabled: false } },
      },
      presentFiles: [],
    });
    expect(effects).toEqual([]);
  });

  test("absent config is silent", async () => {
    const effects = await runFetch({
      firedAt: localTime(5, 15),
      config: undefined,
      presentFiles: [],
    });
    expect(effects).toEqual([]);
  });

  test("malformed entry degrades to one info diagnostic; the sibling still fetches", async () => {
    const effects = await runFetch({
      firedAt: localTime(5, 15),
      config: {
        subscriptions: {
          calendar: { ...CALENDAR },
          slack: { ...CALENDAR, output_path: "sources/slack/today.md" },
        },
      },
      presentFiles: [],
    });

    expect(effects.length).toBe(2);
    const diagnostic = expectDiagnostic(effects, 0);
    expect(diagnostic.severity).toBe("info");
    expect(diagnostic.code).toBe("dome.sources.invalid-config");
    expect(diagnostic.message).toContain('"slack"');
    expect(expectExternal(effects, 1).idempotencyKey).toBe(
      "dome.sources:calendar:2026-06-10",
    );
  });

  test("non-schedule input is a no-op", async () => {
    const effects = await runFetch({
      firedAt: localTime(5, 15),
      config: { subscriptions: { calendar: { ...CALENDAR } } },
      presentFiles: [],
      input: { kind: "adoption", matchedTriggers: [] },
    });
    expect(effects).toEqual([]);
  });
});

async function runFetch(opts: {
  readonly firedAt: Date;
  readonly config: Readonly<Record<string, unknown>> | undefined;
  readonly presentFiles: ReadonlyArray<string>;
  readonly input?: unknown;
}): Promise<ReadonlyArray<Effect>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(opts.presentFiles),
    changedPaths: [],
    proposal: makeManualProposal({
      base: HEAD_COMMIT,
      head: HEAD_COMMIT,
      branch: "main",
    }),
    runId: "run-sources-fetch",
    signal: new AbortController().signal,
    input:
      opts.input ??
      ({
        kind: "schedule",
        cron: "*/15 * * * *",
        firedAt: opts.firedAt.toISOString(),
      } as unknown),
    ...(opts.config !== undefined ? { extensionConfig: opts.config } : {}),
  });
  return fetchProcessor.run(ctx);
}

function fakeSnapshot(presentFiles: ReadonlyArray<string>): Snapshot {
  const present = new Set(presentFiles);
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: treeOid("3333333333333333333333333333333333333333"),
    readFile: async (p: string) =>
      present.has(p) ? "# present\n" : null,
    listMarkdownFiles: async () => Object.freeze([...present]),
    getFileInfo: async () => null,
  });
}

function expectExternal(
  effects: ReadonlyArray<Effect>,
  index: number,
): ExternalActionEffect {
  const effect = effects[index];
  if (effect === undefined || effect.kind !== "external") {
    throw new Error(
      `expected external effect at index ${index}, got ${effect?.kind ?? "none"}`,
    );
  }
  return effect;
}

function expectDiagnostic(
  effects: ReadonlyArray<Effect>,
  index: number,
): DiagnosticEffect {
  const effect = effects[index];
  if (effect === undefined || effect.kind !== "diagnostic") {
    throw new Error(
      `expected diagnostic effect at index ${index}, got ${effect?.kind ?? "none"}`,
    );
  }
  return effect;
}

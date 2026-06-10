// The daily-edition choreography probes (`daily.edition-not-compiled` +
// `daily.calendar-source-missing`).
//
// "Did my morning happen" without reading the daily note — normative at
// docs/wiki/specs/daily-surface.md §"Doctor choreography findings". Both
// probes are read-only and idempotent over (run-ledger dates, working-tree
// calendar files, the brief's manifest cron, now). Severity is warning/info
// by design — the edition's absence is degradation, never corruption — and
// neither probe fires at all when the brief is not enabled (briefCron null).

import { describe, expect, test } from "bun:test";

import { dailyEditionFindings } from "../../src/engine/host/health";

const BRIEF_CRON = "30 5 * * *";

/** Local-time Date for the given YYYY-MM-DD at hh:mm. */
function localTime(date: string, hh: number, mm: number): Date {
  const [yyyy, mo, dd] = date.split("-").map(Number) as [number, number, number];
  return new Date(yyyy, mo - 1, dd, hh, mm);
}

function findingsFor(opts: {
  readonly now: Date;
  readonly briefCron?: string | null;
  readonly briefRunDates?: ReadonlyArray<string>;
  readonly calendarDates?: ReadonlyArray<string>;
}) {
  const calendarDates = new Set(opts.calendarDates ?? []);
  return dailyEditionFindings({
    now: opts.now,
    briefCron: opts.briefCron === undefined ? BRIEF_CRON : opts.briefCron,
    briefRunDates: opts.briefRunDates ?? [],
    calendarFileExists: (date) => calendarDates.has(date),
  });
}

describe("daily.edition-not-compiled", () => {
  test("warning when the cron time passed today and no brief run is in the ledger", () => {
    const findings = findingsFor({
      now: localTime("2026-06-10", 9, 0),
      briefRunDates: ["2026-06-09", "2026-06-08"],
      calendarDates: ["2026-06-09", "2026-06-08"],
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("daily.edition-not-compiled");
    expect(finding.severity).toBe("warning");
    expect(finding.subject).toBe("daily");
    expect(finding.id).toBe("dome.agent.brief");
    expect(finding.message).toContain("2026-06-10");
    expect(finding.recovery).toContain("dome serve");
    if (finding.code === "daily.edition-not-compiled") {
      expect(finding.daily).toEqual({ date: "2026-06-10", cron: BRIEF_CRON });
    }
  });

  test("no finding before the scheduled time (the morning has not been missed yet)", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 5, 0),
        briefRunDates: ["2026-06-09", "2026-06-08"],
        calendarDates: ["2026-06-09", "2026-06-08"],
      }),
    ).toEqual([]);
  });

  test("no finding when a brief run for today is in the ledger (any status counts)", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 9, 0),
        briefRunDates: ["2026-06-10", "2026-06-09"],
        calendarDates: ["2026-06-10", "2026-06-09"],
      }),
    ).toEqual([]);
  });

  test("exactly at the scheduled minute counts as passed", () => {
    const findings = findingsFor({
      now: localTime("2026-06-10", 5, 30),
      briefRunDates: ["2026-06-09"],
      calendarDates: ["2026-06-09"],
    });
    expect(findings.map((f) => f.code)).toContain("daily.edition-not-compiled");
  });

  test("a freshly enabled vault with no brief run history stays quiet (recovery signal, not onboarding nag)", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 9, 0),
        briefRunDates: [],
      }),
    ).toEqual([]);
  });

  test("a malformed cron never throws and never fires", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 9, 0),
        briefCron: "not a cron",
        briefRunDates: [],
      }),
    ).toEqual([]);
  });
});

describe("daily.calendar-source-missing", () => {
  test("info when the brief's two most recent run days both lack a calendar file", () => {
    const findings = findingsFor({
      now: localTime("2026-06-10", 9, 0),
      briefRunDates: ["2026-06-10", "2026-06-09"],
      calendarDates: [],
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("daily.calendar-source-missing");
    expect(finding.severity).toBe("info");
    expect(finding.subject).toBe("daily");
    expect(finding.id).toBe("calendar_source");
    expect(finding.message).toContain("2026-06-10, 2026-06-09");
    expect(finding.recovery).toContain("vault-layout");
    if (finding.code === "daily.calendar-source-missing") {
      expect(finding.daily).toEqual({
        briefRunDates: ["2026-06-10", "2026-06-09"],
      });
    }
  });

  test("one missing day is normal — no finding", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 9, 0),
        briefRunDates: ["2026-06-10", "2026-06-09"],
        calendarDates: ["2026-06-09"],
      }),
    ).toEqual([]);
  });

  test("fewer than two brief run days is not enough evidence", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 9, 0),
        briefRunDates: ["2026-06-10"],
        calendarDates: [],
      }),
    ).toEqual([]);
  });

  test("run-day gaps still count: the two most recent RUN days, not wall-calendar days", () => {
    // Host was off on 2026-06-09; the brief's last two run days are 06-10 and
    // 06-08. Both lack a calendar file -> the signal still fires.
    const findings = findingsFor({
      now: localTime("2026-06-10", 9, 0),
      briefRunDates: ["2026-06-10", "2026-06-08"],
      calendarDates: [],
    });
    expect(findings.map((f) => f.code)).toEqual([
      "daily.calendar-source-missing",
    ]);
  });
});

describe("both probes", () => {
  test("silent when the brief is not enabled (briefCron null)", () => {
    expect(
      findingsFor({
        now: localTime("2026-06-10", 9, 0),
        briefCron: null,
        briefRunDates: [],
      }),
    ).toEqual([]);
  });

  test("never error severity, and both can fire from one probe pass", () => {
    const findings = findingsFor({
      now: localTime("2026-06-10", 9, 0),
      briefRunDates: ["2026-06-09", "2026-06-08"],
      calendarDates: [],
    });
    expect(findings.map((f) => f.code).sort()).toEqual([
      "daily.calendar-source-missing",
      "daily.edition-not-compiled",
    ]);
    expect(findings.every((f) => f.severity !== "error")).toBe(true);
  });

  test("idempotent: the same inputs produce the same findings", () => {
    const opts = {
      now: localTime("2026-06-10", 9, 0),
      briefRunDates: ["2026-06-09", "2026-06-08"],
      calendarDates: [],
    };
    expect(findingsFor(opts)).toEqual(findingsFor(opts));
  });
});

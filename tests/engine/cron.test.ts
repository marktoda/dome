// tests/engine/operational/cron.test.ts — unit tests for the minimal cron evaluator.
//
// Covers parseCron + matchesCron + nextFire across the syntax surface
// the evaluator supports: *, single values, ranges, steps, lists, and
// the classical dom/dow disjunction. Each "due" semantic is verified
// against fixed reference Dates so the tests are deterministic + don't
// drift with real-time.

import { describe, expect, test } from "bun:test";

import { matchesCron, nextFire, parseCron } from "../../src/engine/operational/cron";

describe("parseCron — happy paths", () => {
  test("all-asterisks parses every minute", () => {
    const p = parseCron("* * * * *");
    expect(p.minute.size).toBe(60);
    expect(p.hour.size).toBe(24);
    expect(p.dom.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dow.size).toBe(7);
    expect(p.domAny).toBe(true);
    expect(p.dowAny).toBe(true);
  });

  test("single values populate just that index", () => {
    const p = parseCron("5 9 15 6 1");
    expect([...p.minute]).toEqual([5]);
    expect([...p.hour]).toEqual([9]);
    expect([...p.dom]).toEqual([15]);
    expect([...p.month]).toEqual([6]);
    expect([...p.dow]).toEqual([1]);
    expect(p.domAny).toBe(false);
    expect(p.dowAny).toBe(false);
  });

  test("range M-N is inclusive on both ends", () => {
    const p = parseCron("10-15 * * * *");
    expect([...p.minute]).toEqual([10, 11, 12, 13, 14, 15]);
  });

  test("step */N starts at the field's low bound", () => {
    const p = parseCron("*/15 * * * *");
    expect([...p.minute]).toEqual([0, 15, 30, 45]);
  });

  test("range with step M-N/S", () => {
    const p = parseCron("0-30/10 * * * *");
    expect([...p.minute]).toEqual([0, 10, 20, 30]);
  });

  test("step from a single base M/N goes M, M+N, … up to field max", () => {
    const p = parseCron("5/15 * * * *");
    expect([...p.minute]).toEqual([5, 20, 35, 50]);
  });

  test("list A,B,C unions each", () => {
    const p = parseCron("0,15,30,45 * * * *");
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  test("list of mixed forms is unioned", () => {
    const p = parseCron("0,5-7,*/20 * * * *");
    // 0,5,6,7 from "0,5-7" + 0,20,40 from "*/20" → unioned
    expect([...p.minute].sort((a, b) => a - b)).toEqual([0, 5, 6, 7, 20, 40]);
  });

  test("dow=0 (Sunday) parses", () => {
    const p = parseCron("0 0 * * 0");
    expect([...p.dow]).toEqual([0]);
  });

  test("realistic patterns parse without throwing", () => {
    expect(() => parseCron("0 * * * *")).not.toThrow(); // hourly on the hour
    expect(() => parseCron("0 0 * * *")).not.toThrow(); // daily midnight
    expect(() => parseCron("0 7 * * 1")).not.toThrow(); // Monday 7 AM
    expect(() => parseCron("*/5 * * * *")).not.toThrow(); // every 5 min
  });
});

describe("parseCron — rejections", () => {
  test("wrong field count throws", () => {
    expect(() => parseCron("0 * * *")).toThrow(/5 fields/);
    expect(() => parseCron("0 * * * * *")).toThrow(/5 fields/);
    expect(() => parseCron("")).toThrow(/5 fields/);
  });

  test("out-of-range single value throws", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * 7")).toThrow(/out of range/);
  });

  test("malformed step throws", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/positive/);
    expect(() => parseCron("*/abc * * * *")).toThrow(/positive/);
  });

  test("malformed range throws", () => {
    expect(() => parseCron("5-3 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("abc * * * *")).toThrow(/non-integer/);
  });
});

describe("matchesCron — per-field", () => {
  test("every-minute pattern matches any minute", () => {
    const p = parseCron("* * * * *");
    expect(matchesCron(p, new Date(2026, 0, 1, 10, 30))).toBe(true);
    expect(matchesCron(p, new Date(2026, 11, 31, 23, 59))).toBe(true);
  });

  test("hourly pattern matches only minute=0", () => {
    const p = parseCron("0 * * * *");
    expect(matchesCron(p, new Date(2026, 0, 1, 10, 0))).toBe(true);
    expect(matchesCron(p, new Date(2026, 0, 1, 10, 1))).toBe(false);
    expect(matchesCron(p, new Date(2026, 0, 1, 10, 30))).toBe(false);
  });

  test("daily 7am matches only that minute", () => {
    const p = parseCron("0 7 * * *");
    expect(matchesCron(p, new Date(2026, 0, 1, 7, 0))).toBe(true);
    expect(matchesCron(p, new Date(2026, 0, 1, 8, 0))).toBe(false);
    expect(matchesCron(p, new Date(2026, 0, 1, 7, 1))).toBe(false);
  });

  test("weekly Monday 7am matches", () => {
    const p = parseCron("0 7 * * 1");
    // Jan 5, 2026 is a Monday.
    expect(matchesCron(p, new Date(2026, 0, 5, 7, 0))).toBe(true);
    // Jan 6, 2026 is a Tuesday.
    expect(matchesCron(p, new Date(2026, 0, 6, 7, 0))).toBe(false);
  });
});

describe("matchesCron — dom/dow disjunction", () => {
  test("when both restricted, matches if EITHER dom OR dow matches", () => {
    // 1st of month OR Sunday at midnight.
    const p = parseCron("0 0 1 * 0");
    // Jan 1, 2026 is a Thursday (dom=1 matches, dow=4 doesn't) — still matches.
    expect(matchesCron(p, new Date(2026, 0, 1, 0, 0))).toBe(true);
    // Jan 4, 2026 is a Sunday (dow=0 matches, dom=4 doesn't) — still matches.
    expect(matchesCron(p, new Date(2026, 0, 4, 0, 0))).toBe(true);
    // Jan 5, 2026 is a Monday (dow=1, dom=5) — neither matches → false.
    expect(matchesCron(p, new Date(2026, 0, 5, 0, 0))).toBe(false);
  });

  test("when only dom is restricted, only dom matters", () => {
    const p = parseCron("0 0 1 * *");
    expect(matchesCron(p, new Date(2026, 0, 1, 0, 0))).toBe(true); // dom=1
    expect(matchesCron(p, new Date(2026, 0, 2, 0, 0))).toBe(false); // dom=2
  });

  test("when only dow is restricted, only dow matters", () => {
    const p = parseCron("0 0 * * 0");
    expect(matchesCron(p, new Date(2026, 0, 4, 0, 0))).toBe(true); // Sunday
    expect(matchesCron(p, new Date(2026, 0, 5, 0, 0))).toBe(false); // Monday
  });
});

describe("nextFire — round-tripping", () => {
  test("hourly pattern: next fire is the next top-of-hour", () => {
    const p = parseCron("0 * * * *");
    const after = new Date(2026, 0, 1, 10, 30, 0);
    const next = nextFire(p, after);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
    expect(next.getSeconds()).toBe(0);
  });

  test("when `after` already matches the cron, nextFire returns the NEXT match (strictly after)", () => {
    const p = parseCron("0 * * * *");
    const onTheHour = new Date(2026, 0, 1, 10, 0, 0);
    const next = nextFire(p, onTheHour);
    expect(next.getHours()).toBe(11);
    expect(next.getMinutes()).toBe(0);
  });

  test("daily 7am: next fire is next 7am", () => {
    const p = parseCron("0 7 * * *");
    const after = new Date(2026, 0, 1, 9, 0, 0);
    const next = nextFire(p, after);
    expect(next.getDate()).toBe(2); // next day (since today's 7am already passed)
    expect(next.getHours()).toBe(7);
  });

  test("weekly Monday 7am: next fire is next Monday", () => {
    const p = parseCron("0 7 * * 1");
    // Tuesday Jan 6 noon → next Monday is Jan 12.
    const after = new Date(2026, 0, 6, 12, 0, 0);
    const next = nextFire(p, after);
    expect(next.getDate()).toBe(12);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getHours()).toBe(7);
  });

  test("every-5-minutes: next fire is +5 from now (rounded down)", () => {
    const p = parseCron("*/5 * * * *");
    const after = new Date(2026, 0, 1, 10, 3, 0);
    const next = nextFire(p, after);
    expect(next.getMinutes()).toBe(5);
    expect(next.getHours()).toBe(10);
  });

  test("nextFire seconds are zeroed", () => {
    const p = parseCron("* * * * *");
    const after = new Date(2026, 0, 1, 10, 30, 27, 481);
    const next = nextFire(p, after);
    expect(next.getSeconds()).toBe(0);
    expect(next.getMilliseconds()).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";

import {
  dailyPath,
  parseDailyPath,
} from "../../assets/extensions/dome.daily/processors/daily-shared";

describe("dome.daily shared date helpers", () => {
  test("parseDailyPath accepts real daily dates", () => {
    expect(dailyPath({ yyyy: "2026", mm: "02", dd: "28" })).toBe(
      "wiki/dailies/2026-02-28.md",
    );
    expect(parseDailyPath("wiki/dailies/2026-02-28.md")).toEqual({
      yyyy: "2026",
      mm: "02",
      dd: "28",
    });
  });

  test("parseDailyPath rejects calendar-impossible dates", () => {
    expect(parseDailyPath("wiki/dailies/2026-02-31.md")).toBeNull();
    expect(parseDailyPath("wiki/dailies/2026-13-01.md")).toBeNull();
    expect(parseDailyPath("wiki/dailies/2026-00-10.md")).toBeNull();
  });
});

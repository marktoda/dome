import { describe, expect, test } from "bun:test";

import {
  carriedForwardSection,
  dailyPath,
  openTasksFromMarkdown,
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

  test("openTasksFromMarkdown extracts plain open markdown checkboxes", () => {
    expect(
      openTasksFromMarkdown(
        [
          "- [ ] #task Follow up",
          "  * [ ] Review notes",
          "- [x] Finished item",
          "- [ ]",
          "plain text",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 1,
        text: "- [ ] #task Follow up",
        sourcePath: null,
        body: "#task Follow up",
        followup: false,
      },
      {
        line: 2,
        text: "  * [ ] Review notes",
        sourcePath: null,
        body: "Review notes",
        followup: false,
      },
    ]);
  });

  test("openTasksFromMarkdown preserves existing carry-forward provenance", () => {
    expect(
      openTasksFromMarkdown(
        "- [ ] Already carried (from [[wiki/dailies/2025-12-31]])",
      ),
    ).toEqual([
      {
        line: 1,
        text: "- [ ] Already carried",
        sourcePath: "wiki/dailies/2025-12-31",
        body: "Already carried",
        followup: false,
      },
    ]);
  });

  test("openTasksFromMarkdown marks explicit followups without guessing prose", () => {
    expect(
      openTasksFromMarkdown(
        [
          "- [ ] #followup Send Ada launch notes",
          "- [ ] Follow up with Ben",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 1,
        text: "- [ ] #followup Send Ada launch notes",
        sourcePath: null,
        body: "#followup Send Ada launch notes",
        followup: true,
      },
      {
        line: 2,
        text: "- [ ] Follow up with Ben",
        sourcePath: null,
        body: "Follow up with Ben",
        followup: false,
      },
    ]);
  });

  test("carriedForwardSection uses original provenance when available", () => {
    expect(
      carriedForwardSection({
        yesterday: { yyyy: "2026", mm: "01", dd: "01" },
        tasks: [
          {
            line: 1,
            text: "- [ ] New task",
            sourcePath: null,
            body: "New task",
            followup: false,
          },
          {
            line: 2,
            text: "- [ ] Already carried",
            sourcePath: "wiki/dailies/2025-12-31",
            body: "Already carried",
            followup: false,
          },
        ],
      }),
    ).toContain(
      [
        "- [ ] New task (from [[wiki/dailies/2026-01-01]])",
        "- [ ] Already carried (from [[wiki/dailies/2025-12-31]])",
      ].join("\n"),
    );
  });
});

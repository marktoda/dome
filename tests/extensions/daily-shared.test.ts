import { describe, expect, test } from "bun:test";

import {
  actionItemsFromMarkdown,
  ambiguousFollowupsFromMarkdown,
  carriedForwardSection,
  completedSourceBackedOpenLoopsFromMarkdown,
  dailyPathSettings,
  dailyPath,
  openLoopIdentity,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  openTasksFromMarkdown,
  parseDailyPath,
  renderDailySkeleton,
  replaceOpenLoopSurfaceSection,
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

  test("daily_path config can move the daily surface to notes", () => {
    const settings = dailyPathSettings({ daily_path: "notes/{date}.md" });
    expect(dailyPath({ yyyy: "2026", mm: "02", dd: "28" }, settings)).toBe(
      "notes/2026-02-28.md",
    );
    expect(parseDailyPath("notes/2026-02-28.md", settings)).toEqual({
      yyyy: "2026",
      mm: "02",
      dd: "28",
    });
    expect(parseDailyPath("wiki/dailies/2026-02-28.md", settings)).toBeNull();
  });

  test("daily_path config rejects unsafe or non-daily templates", () => {
    expect(() => dailyPathSettings({ daily_path: "/notes/{date}.md" })).toThrow(
      "relative vault markdown path",
    );
    expect(() => dailyPathSettings({ daily_path: "notes/today.md" })).toThrow(
      "exactly one {date}",
    );
    expect(() => dailyPathSettings({ daily_path: "notes/{date}.txt" })).toThrow(
      ".md file",
    );
  });

  test("parseDailyPath rejects calendar-impossible dates", () => {
    expect(parseDailyPath("wiki/dailies/2026-02-31.md")).toBeNull();
    expect(parseDailyPath("wiki/dailies/2026-13-01.md")).toBeNull();
    expect(parseDailyPath("wiki/dailies/2026-00-10.md")).toBeNull();
  });

  test("renderDailySkeleton uses the V1 work-surface shape", () => {
    expect(
      renderDailySkeleton({
        today: { yyyy: "2026", mm: "02", dd: "28" },
        yesterday: { yyyy: "2026", mm: "02", dd: "27" },
      }),
    ).toContain(
      [
        "## Start Here",
        "",
        "## Meetings",
        "",
        "## Open Loops",
        "",
        "## Notes",
        "",
        "## Decisions",
        "",
        "## Done",
        "",
        "## Story of the Day",
      ].join("\n"),
    );
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
        body: "Follow up",
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
          "- [ ] #task #followup Confirm review timing",
          "- [ ] Follow up with Ben",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 1,
        text: "- [ ] #followup Send Ada launch notes",
        sourcePath: null,
        body: "Send Ada launch notes",
        followup: true,
      },
      {
        line: 2,
        text: "- [ ] #task #followup Confirm review timing",
        sourcePath: null,
        body: "Confirm review timing",
        followup: true,
      },
      {
        line: 3,
        text: "- [ ] Follow up with Ben",
        sourcePath: null,
        body: "Follow up with Ben",
        followup: false,
      },
    ]);
  });

  test("actionItemsFromMarkdown extracts deterministic TODO and follow-up directives", () => {
    expect(
      actionItemsFromMarkdown(
        [
          "TODO: Send budget update",
          "- Follow up: Confirm Q3 plan with Eli",
          "We should follow up with Sam about hiring",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 1,
        text: "TODO: Send budget update",
        body: "Send budget update",
        followup: false,
      },
      {
        line: 2,
        text: "- Follow up: Confirm Q3 plan with Eli",
        body: "Confirm Q3 plan with Eli",
        followup: true,
      },
    ]);
  });

  test("actionItemsFromMarkdown skips Dome-generated daily sections", () => {
    expect(
      actionItemsFromMarkdown(
        [
          "TODO: Keep source item",
          "<!-- dome.daily:open-loops:start -->",
          "### Source-backed Open Loops",
          "- [ ] Generated copy should not become source",
          "<!-- dome.daily:open-loops:end -->",
          "Follow up: Keep second source item",
        ].join("\n"),
      ).map((item) => item.body),
    ).toEqual(["Keep source item", "Keep second source item"]);
  });

  test("ambiguousFollowupsFromMarkdown asks only for prose follow-up guesses", () => {
    expect(
      ambiguousFollowupsFromMarkdown(
        [
          "TODO: Send budget update",
          "- [ ] #followup Explicit checkbox",
          "- [x] Follow up with completed person",
          "- Follow up: Explicit directive",
          "We should follow up with Sam about hiring",
          "Please follow up with other teams about staffing.",
          "12 assets is the right starting number, with potential to follow up with more.",
          "The first note can follow up with additional examples later.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 5,
        text: "We should follow up with Sam about hiring",
      },
      {
        line: 6,
        text: "Please follow up with other teams about staffing.",
      },
    ]);
  });

  test("openLoopSurfaceSection renders and replaces a small source-backed block", () => {
    const items = openLoopSurfaceSources({
      path: "wiki/projects/alpha.md",
      content: [
        "# Alpha",
        "",
        "TODO: Send budget update",
        "Follow up: Confirm Q3 plan with Eli",
      ].join("\n"),
    });
    const section = openLoopSurfaceSection({ items });
    expect(section).toContain(
      "- [ ] Send budget update (from [[wiki/projects/alpha]])",
    );
    expect(section).toContain(
      "- [ ] #followup Confirm Q3 plan with Eli (from [[wiki/projects/alpha]])",
    );

    const daily = [
      "# 2026-02-28",
      "",
      "## Open Loops",
      "",
      "Human note stays here.",
      "",
      "## Notes",
      "",
    ].join("\n");
    const next = replaceOpenLoopSurfaceSection({ content: daily, section });
    expect(next).toContain("## Open Loops\n\n<!-- dome.daily:open-loops:start -->");
    expect(next).toContain("Human note stays here.");
    expect(
      replaceOpenLoopSurfaceSection({ content: next, section }),
    ).toBe(next);
  });

  test("checked source-backed entries are durable daily resolution evidence", () => {
    const resolved = completedSourceBackedOpenLoopsFromMarkdown({
      path: "wiki/dailies/2026-02-28.md",
      content: [
        "## Open Loops",
        "",
        "<!-- dome.daily:open-loops:start -->",
        "### Source-backed Open Loops",
        "- [x] #followup Confirm Q3 plan with Eli (from [[wiki/projects/alpha]])",
        "<!-- dome.daily:open-loops:end -->",
      ].join("\n"),
    });

    expect(resolved).toEqual([
      {
        line: 5,
        path: "wiki/dailies/2026-02-28.md",
        body: "Confirm Q3 plan with Eli",
        followup: true,
        sourcePath: "wiki/projects/alpha.md",
      },
    ]);
    expect(openLoopIdentity(resolved[0]!)).toBe(
      '["wiki/projects/alpha.md","confirm q3 plan with eli"]',
    );

    const section = openLoopSurfaceSection({
      items: [],
      resolvedItems: resolved,
    });
    expect(section).toContain("### Resolved Today");
    expect(section).toContain(
      "- [x] #followup Confirm Q3 plan with Eli (from [[wiki/projects/alpha]])",
    );
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

  test("carriedForwardSection follows configured daily links", () => {
    const settings = dailyPathSettings({ daily_path: "notes/{date}.md" });
    expect(
      carriedForwardSection({
        yesterday: { yyyy: "2026", mm: "01", dd: "01" },
        settings,
        tasks: [
          {
            line: 1,
            text: "- [ ] New task",
            sourcePath: null,
            body: "New task",
            followup: false,
          },
        ],
      }),
    ).toContain("- [ ] New task (from [[notes/2026-01-01]])");
  });
});

import { describe, expect, test } from "bun:test";

import {
  actionItemsFromMarkdown,
  ambiguousFollowupsFromMarkdown,
  carriedForwardSection,
  completedSourceBackedOpenLoopsFromMarkdown,
  dailyStartContextSection,
  dailyPathSettings,
  dailyPath,
  openLoopIdentity,
  openLoopStableId,
  openLoopSurfaceSection,
  openLoopSurfaceKey,
  openLoopSurfaceSources,
  openTasksFromMarkdown,
  parseDailyPath,
  previousDailyStartContext,
  rankDailyOpenLoopSurfaceItems,
  renderDailySkeleton,
  replaceDailyStartContextSection,
  replaceOpenLoopSurfaceSection,
  settledSourceBackedOpenLoopsFromMarkdown,
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

  test("daily start context summarizes yesterday with stable markers", () => {
    const context = previousDailyStartContext({
      previousPath: "wiki/dailies/2026-02-27.md",
      previousContent: [
        "# 2026-02-27",
        "",
        "## Start Here",
        "",
        "<!-- dome.daily:start-context:start -->",
        "### Since Yesterday",
        "- [ ] Generated checkbox should not become source",
        "<!-- dome.daily:start-context:end -->",
        "",
        "## Decisions",
        "",
        "- Keep alpha review in the weekly plan.",
        "- [x] Use the lighter staffing packet.",
        "",
        "## Done",
        "",
        "- Sent Ada the staffing note.",
        "- [x] Closed the hiring-budget follow-up.",
        "",
        "## Story of the Day",
        "",
        "Alpha review moved forward after the staffing packet landed.",
        "The hiring-budget thread is still open.",
        "",
      ].join("\n"),
    });

    const section = dailyStartContextSection(context);
    expect(section).toBe(
      [
        "<!-- dome.daily:start-context:start -->",
        "### Since Yesterday",
        "- Previous daily: [[wiki/dailies/2026-02-27]]",
        "- Done yesterday: Sent Ada the staffing note.; Closed the hiring-budget follow-up.",
        "- Decisions yesterday: Keep alpha review in the weekly plan.; Use the lighter staffing packet.",
        "- Story: Alpha review moved forward after the staffing packet landed. The hiring-budget thread is still open.",
        "<!-- dome.daily:start-context:end -->",
      ].join("\n"),
    );

    const daily = [
      "# 2026-02-28",
      "",
      "## Start Here",
      "",
      "Human note stays here.",
      "",
      "## Meetings",
      "",
    ].join("\n");
    const next = replaceDailyStartContextSection({
      content: daily,
      section,
    });
    expect(next).toContain(
      "## Start Here\n\n<!-- dome.daily:start-context:start -->",
    );
    expect(next).toContain("Human note stays here.");
    expect(replaceDailyStartContextSection({ content: next, section })).toBe(
      next,
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
        origin: "directive",
      },
      {
        line: 2,
        text: "- Follow up: Confirm Q3 plan with Eli",
        body: "Confirm Q3 plan with Eli",
        followup: true,
        origin: "directive",
      },
    ]);
  });

  test("actionItemsFromMarkdown skips Dome-generated daily sections", () => {
    expect(
      actionItemsFromMarkdown(
        [
          "TODO: Keep source item",
          "<!-- dome.daily:start-context:start -->",
          "### Since Yesterday",
          "- [ ] Generated checkbox should not become source",
          "<!-- dome.daily:start-context:end -->",
          "<!-- dome.daily:open-loops:start -->",
          "### Source-backed Open Loops",
          "- [ ] Generated copy should not become source",
          "<!-- dome.daily:open-loops:end -->",
          "Follow up: Keep second source item",
        ].join("\n"),
      ).map((item) => item.body),
    ).toEqual(["Keep source item", "Keep second source item"]);
  });

  test("actionItemsFromMarkdown skips frontmatter metadata", () => {
    expect(
      actionItemsFromMarkdown(
        [
          "---",
          "type: capture",
          "text: TODO: Ignore frontmatter action",
          "---",
          "",
          "TODO: Keep body action",
        ].join("\n"),
      ).map((item) => item.body),
    ).toEqual(["Keep body action"]);
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

  test("ambiguousFollowupsFromMarkdown skips frontmatter and quotes", () => {
    expect(
      ambiguousFollowupsFromMarkdown(
        [
          "---",
          "type: capture",
          "text: Follow up with Ben about budget",
          "---",
          "",
          "> Follow up with Ben about budget",
          "",
          "We should follow up with Ben about budget.",
        ].join("\n"),
      ),
    ).toEqual([
      {
        line: 8,
        text: "We should follow up with Ben about budget.",
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

  test("rankDailyOpenLoopSurfaceItems folds repeated surface loops", () => {
    const duplicateBody = "Send budget update";
    expect(openLoopSurfaceKey({ body: duplicateBody })).toBe(
      "send budget update",
    );

    const ranked = rankDailyOpenLoopSurfaceItems([
      {
        line: 4,
        stableId: openLoopStableId({
          sourcePath: "wiki/projects/old.md",
          body: duplicateBody,
        }),
        body: duplicateBody,
        followup: false,
        sourcePath: "wiki/projects/old.md",
        lastChangedAt: "2026-01-01T09:00:00.000Z",
      },
      {
        line: 8,
        stableId: openLoopStableId({
          sourcePath: "wiki/projects/new.md",
          body: duplicateBody,
        }),
        body: duplicateBody,
        followup: false,
        sourcePath: "wiki/projects/new.md",
        lastChangedAt: "2026-01-05T09:00:00.000Z",
      },
      {
        line: 2,
        stableId: openLoopStableId({
          sourcePath: "wiki/projects/other.md",
          body: "Confirm Q3 plan",
        }),
        body: "Confirm Q3 plan",
        followup: false,
        sourcePath: "wiki/projects/other.md",
        lastChangedAt: "2026-01-03T09:00:00.000Z",
      },
    ]);

    expect(ranked.map((item) => item.body)).toEqual([
      duplicateBody,
      "Confirm Q3 plan",
    ]);
    expect(ranked[0]?.sourcePath).toBe("wiki/projects/new.md");
  });

  test("openLoopSurfaceSources filters unmarked non-daily checklists", () => {
    expect(
      openLoopSurfaceSources({
        path: "wiki/entities/ada.md",
        content: [
          "# Ada",
          "",
          "- [ ] Static checklist line",
          "- [ ] #task Marked checkbox task",
          "- [ ] Dated checkbox task 2026-02-28",
          "TODO: Explicit directive",
          "Follow up: Explicit followup",
        ].join("\n"),
      }).map((item) => item.body),
    ).toEqual([
      "Marked checkbox task",
      "Dated checkbox task 2026-02-28",
      "Explicit directive",
      "Explicit followup",
    ]);

    expect(
      openLoopSurfaceSources({
        path: "notes/2026-02-28.md",
        settings: dailyPathSettings({ daily_path: "notes/{date}.md" }),
        content: [
          "# 2026-02-28",
          "",
          "- [ ] Plain daily checkbox still carries forward",
        ].join("\n"),
      }).map((item) => item.body),
    ).toEqual(["Plain daily checkbox still carries forward"]);
  });

  test("replaceOpenLoopSurfaceSection inserts after today's tasks when present", () => {
    const section = openLoopSurfaceSection({
      items: [
        {
          line: 3,
          stableId: openLoopStableId({
            sourcePath: "wiki/projects/alpha.md",
            body: "Ship budget update",
          }),
          body: "Ship budget update",
          followup: false,
          sourcePath: "wiki/projects/alpha.md",
        },
      ],
    });
    if (section === null) throw new Error("expected section");

    const daily = [
      "# Notes",
      "",
      "# Today's tasks",
      "- [ ] Existing human task",
      "",
      "# What did I get done today?",
      "",
      "# Story of the day",
      "",
    ].join("\n");
    const next = replaceOpenLoopSurfaceSection({ content: daily, section });
    expect(next).toContain(
      [
        "# Today's tasks",
        "- [ ] Existing human task",
        "",
        "## Open Loops",
        "",
        "<!-- dome.daily:open-loops:start -->",
      ].join("\n"),
    );
    expect(next.indexOf("## Open Loops")).toBeLessThan(
      next.indexOf("# What did I get done today?"),
    );
  });

  test("replaceOpenLoopSurfaceSection relocates bottom-generated blocks", () => {
    const section = openLoopSurfaceSection({
      items: [
        {
          line: 3,
          stableId: openLoopStableId({
            sourcePath: "wiki/projects/alpha.md",
            body: "Ship budget update",
          }),
          body: "Ship budget update",
          followup: false,
          sourcePath: "wiki/projects/alpha.md",
        },
      ],
    });
    if (section === null) throw new Error("expected section");

    const daily = [
      "# Notes",
      "",
      "# Today's tasks",
      "- [ ] Existing human task",
      "",
      "# What did I get done today?",
      "",
      "# Story of the day",
      "",
      "## Open Loops",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "### Source-backed Open Loops",
      "- [ ] Old placement (from [[wiki/projects/old]])",
      "<!-- dome.daily:open-loops:end -->",
    ].join("\n");
    const next = replaceOpenLoopSurfaceSection({ content: daily, section });
    expect(next).toContain("- [ ] Ship budget update");
    expect(next).not.toContain("Old placement");
    expect(next.indexOf("## Open Loops")).toBeLessThan(
      next.indexOf("# What did I get done today?"),
    );
    expect(next.trimEnd().endsWith("# Story of the day")).toBe(true);
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
        stableId: openLoopStableId({
          sourcePath: "wiki/projects/alpha.md",
          body: "Confirm Q3 plan with Eli",
        }),
        path: "wiki/dailies/2026-02-28.md",
        body: "Confirm Q3 plan with Eli",
        followup: true,
        sourcePath: "wiki/projects/alpha.md",
        status: "resolved",
      },
    ]);
    const firstResolved = resolved[0];
    if (firstResolved === undefined) throw new Error("expected resolved item");
    expect(openLoopIdentity(firstResolved)).toBe(firstResolved.stableId);

    const section = openLoopSurfaceSection({
      items: [],
      settledItems: resolved,
    });
    expect(section).toContain("### Resolved Today");
    expect(section).toContain(
      "- [x] #followup Confirm Q3 plan with Eli (from [[wiki/projects/alpha]])",
    );
  });

  test("dismissed source-backed entries are durable daily settlement evidence", () => {
    const settled = settledSourceBackedOpenLoopsFromMarkdown({
      path: "wiki/dailies/2026-02-28.md",
      content: [
        "## Open Loops",
        "",
        "<!-- dome.daily:open-loops:start -->",
        "### Source-backed Open Loops",
        "- [-] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
        "<!-- dome.daily:open-loops:end -->",
      ].join("\n"),
    });

    expect(settled).toEqual([
      {
        line: 5,
        stableId: openLoopStableId({
          sourcePath: "wiki/projects/alpha.md",
          body: "Archive the launch staffing thread",
        }),
        path: "wiki/dailies/2026-02-28.md",
        body: "Archive the launch staffing thread",
        followup: false,
        sourcePath: "wiki/projects/alpha.md",
        status: "dismissed",
      },
    ]);

    const section = openLoopSurfaceSection({
      items: [],
      settledItems: settled,
    });
    expect(section).toContain("### Dismissed Today");
    expect(section).toContain(
      "- [-] Archive the launch staffing thread (from [[wiki/projects/alpha]])",
    );
    expect(
      completedSourceBackedOpenLoopsFromMarkdown({
        path: "wiki/dailies/2026-02-28.md",
        content: section ?? "",
      }),
    ).toEqual([]);
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

import { describe, expect, test } from "bun:test";

import {
  actionItemsFromMarkdown,
  ambiguousFollowupsFromMarkdown,
  openTasksFromMarkdown,
  settledActionItemsFromMarkdown,
} from "../../assets/extensions/dome.daily/processors/action-extraction";
import { dailyPath, dailyPathSettings, parseDailyPath } from "../../assets/extensions/dome.daily/processors/daily-paths";
import {
  carriedForwardSection,
  closeDigestFromDailyContent,
  closeScaffoldSection,
  ensureCloseScaffoldSection,
  ensureYesterdayFallbackSection,
  previousDailyDigest,
  removeLegacyStartContextSection,
  renderDailySkeleton,
  yesterdayFallbackSection,
} from "../../assets/extensions/dome.daily/processors/daily-scaffold";
import {
  completedSourceBackedOpenLoopsFromMarkdown,
  openLoopFreshnessKey,
  openLoopIdentity,
  openLoopStableId,
  openLoopSurfaceKey,
  openLoopSurfaceSection,
  openLoopSurfaceSources,
  rankDailyOpenLoopSurfaceItems,
  replaceOpenLoopSurfaceSection,
  settledSourceBackedOpenLoopsFromMarkdown,
} from "../../assets/extensions/dome.daily/processors/open-loop-surface";

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
    const skeleton = renderDailySkeleton({
      today: { yyyy: "2026", mm: "02", dd: "28" },
      yesterday: { yyyy: "2026", mm: "02", dd: "27" },
    });
    // Captured today is the FIRST content section, hosting the (empty)
    // dome.daily:captured block (daily-surface section contract, D3).
    expect(skeleton).toContain(
      [
        "## Captured today",
        "",
        "<!-- dome.daily:captured:start -->",
      ].join("\n"),
    );
    expect(skeleton.indexOf("## Captured today")).toBeLessThan(
      skeleton.indexOf("## Start Here"),
    );
    expect(skeleton).toContain(
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

  test("yesterday fallback summarizes yesterday inside the unified brief block", () => {
    const digest = previousDailyDigest({
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

    const section = yesterdayFallbackSection(digest);
    expect(section).toBe(
      [
        "<!-- dome.agent.brief:yesterday:start -->",
        "### Yesterday",
        "- Previous daily: [[wiki/dailies/2026-02-27]]",
        "- Done yesterday: Sent Ada the staffing note.; Closed the hiring-budget follow-up.",
        "- Decisions yesterday: Keep alpha review in the weekly plan.; Use the lighter staffing packet.",
        "- Story: Alpha review moved forward after the staffing packet landed. The hiring-budget thread is still open.",
        "<!-- dome.agent.brief:yesterday:end -->",
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
    const next = ensureYesterdayFallbackSection({
      content: daily,
      section,
    });
    expect(next).toContain(
      "## Start Here\n\n<!-- dome.agent.brief:yesterday:start -->",
    );
    expect(next).toContain("Human note stays here.");
    expect(ensureYesterdayFallbackSection({ content: next, section })).toBe(
      next,
    );
  });

  test("no previous daily degrades to a single no-record line, never an absent block", () => {
    expect(yesterdayFallbackSection(null)).toBe(
      [
        "<!-- dome.agent.brief:yesterday:start -->",
        "### Yesterday",
        "- No record of yesterday — no previous daily note.",
        "<!-- dome.agent.brief:yesterday:end -->",
      ].join("\n"),
    );
  });

  test("ensureYesterdayFallbackSection leaves an existing (curated) block alone entirely", () => {
    const daily = [
      "# 2026-02-28",
      "",
      "## Start Here",
      "",
      "<!-- dome.agent.brief:yesterday:start -->",
      "### Yesterday",
      "- Curated by the brief (from [[wiki/dailies/2026-02-27]])",
      "<!-- dome.agent.brief:yesterday:end -->",
      "",
      "## Meetings",
      "",
    ].join("\n");
    const next = ensureYesterdayFallbackSection({
      content: daily,
      section: yesterdayFallbackSection(null),
    });
    expect(next).toBe(daily);
    expect(next).not.toContain("No record of yesterday");
  });

  test("removeLegacyStartContextSection removes the retired block once, idempotently", () => {
    const daily = [
      "# 2026-02-28",
      "",
      "## Start Here",
      "",
      "<!-- dome.daily:start-context:start -->",
      "### Since Yesterday",
      "- Previous daily: [[wiki/dailies/2026-02-27]]",
      "<!-- dome.daily:start-context:end -->",
      "",
      "Human note stays here.",
      "",
      "## Meetings",
      "",
    ].join("\n");
    const removed = removeLegacyStartContextSection(daily);
    expect(removed).not.toContain("dome.daily:start-context");
    expect(removed).not.toContain("### Since Yesterday");
    expect(removed).toContain("## Start Here\n\nHuman note stays here.");
    expect(removed).toContain("## Meetings");
    // Idempotent: once removed (and nothing writes the marker anymore), a
    // second pass is a no-op — the block never reappears.
    expect(removeLegacyStartContextSection(removed)).toBe(removed);
  });

  test("closeScaffoldSection renders candidates, the still-open line-up, and the story pointer", () => {
    const section = closeScaffoldSection({
      doneCandidates: [
        {
          line: 12,
          body: "Sent Ada the staffing note",
          status: "resolved",
          originPath: "wiki/projects/alpha.md",
        },
        {
          line: 14,
          body: "Chase the stale vendor quote",
          status: "dismissed",
          originPath: "wiki/projects/beta.md",
        },
        {
          line: 20,
          body: "Booked the offsite room",
          status: "resolved",
          originPath: null,
        },
      ],
      stillOpen: [
        { line: 5, stableId: "a", body: "Draft the rollout plan", followup: false, sourcePath: "wiki/projects/alpha.md" },
        { line: 6, stableId: "b", body: "Review the audit findings", followup: false, sourcePath: "wiki/projects/beta.md" },
        { line: 7, stableId: "c", body: "Ping legal about the filing", followup: true, sourcePath: "wiki/people/dana.md" },
        { line: 8, stableId: "d", body: "Refresh the metrics dashboard", followup: false, sourcePath: "wiki/projects/gamma.md" },
      ],
    });
    expect(section).toBe(
      [
        "<!-- dome.daily:close:start -->",
        "### Done today",
        "Candidates from today's settles — keep what counts, delete the rest.",
        "- Sent Ada the staffing note (from [[wiki/projects/alpha]])",
        "- Dismissed: Chase the stale vendor quote (from [[wiki/projects/beta]])",
        "- Booked the offsite room",
        "### Still open",
        "- 4 loops still open — top: Draft the rollout plan; Review the audit findings; Ping legal about the filing",
        "### Story of the Day",
        "The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.",
        "<!-- dome.daily:close:end -->",
      ].join("\n"),
    );
  });

  test("closeScaffoldSection with nothing settled and a clear surface renders the explicit empty scaffold", () => {
    const section = closeScaffoldSection({ doneCandidates: [], stillOpen: [] });
    // Zero BULLETS under "### Done today" is what "empty close" means to
    // tomorrow's reader — the placeholder is a non-bullet line.
    expect(section).toContain("### Done today\nNothing recorded as settled today.");
    expect(section).toContain("- No loops still open.");
  });

  test("ensureCloseScaffoldSection inserts under ## Done and leaves an existing block alone entirely", () => {
    const section = closeScaffoldSection({ doneCandidates: [], stillOpen: [] });
    const daily = [
      "# 2026-02-28",
      "",
      "## Done",
      "",
      "## Story of the Day",
      "",
    ].join("\n");
    const next = ensureCloseScaffoldSection({ content: daily, section });
    expect(next).toContain("## Done\n\n<!-- dome.daily:close:start -->");
    // The heading LINE (not the pointer line's mid-line mention) follows the
    // block — the section order is preserved.
    expect(next).toContain(
      "<!-- dome.daily:close:end -->\n\n## Story of the Day",
    );

    // Presence gate: the human's edited block survives verbatim.
    const edited = next.replace(
      "Nothing recorded as settled today.",
      "- Shipped the close scaffold",
    );
    expect(ensureCloseScaffoldSection({ content: edited, section })).toBe(
      edited,
    );
  });

  test("ensureCloseScaffoldSection creates a missing ## Done heading before the story section", () => {
    const section = closeScaffoldSection({ doneCandidates: [], stillOpen: [] });
    const daily = ["# 2026-02-28", "", "## Story of the Day", ""].join("\n");
    const next = ensureCloseScaffoldSection({ content: daily, section });
    expect(next).toContain("## Done\n\n<!-- dome.daily:close:start -->");
    expect(next.indexOf("## Done")).toBeLessThan(
      next.indexOf("## Story of the Day"),
    );
  });

  test("closeDigestFromDailyContent reads kept bullets and the still-open count, ignoring hint lines", () => {
    const content = [
      "# 2026-02-27",
      "",
      "## Done",
      "",
      "<!-- dome.daily:close:start -->",
      "### Done today",
      "Candidates from today's settles — keep what counts, delete the rest.",
      "- Sent Ada the staffing note (from [[wiki/projects/alpha]])",
      "- Booked the offsite room",
      "### Still open",
      "- 4 loops still open — top: Draft the rollout plan; Review the audit findings; Ping legal about the filing",
      "### Story of the Day",
      "The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.",
      "<!-- dome.daily:close:end -->",
      "",
    ].join("\n");
    expect(closeDigestFromDailyContent(content)).toEqual({
      kept: [
        "Sent Ada the staffing note (from [[wiki/projects/alpha]])",
        "Booked the offsite room",
      ],
      stillOpenCount: 4,
    });
    expect(closeDigestFromDailyContent("## Done\n\n- Loose bullet\n")).toBeNull();
    expect(
      closeDigestFromDailyContent(
        [
          "<!-- dome.daily:close:start -->",
          "### Done today",
          "Nothing recorded as settled today.",
          "### Still open",
          "- No loops still open.",
          "<!-- dome.daily:close:end -->",
        ].join("\n"),
      ),
    ).toEqual({ kept: [], stillOpenCount: 0 });
  });

  test("tomorrow's fallback prefers the close: kept candidates + carried count, no section scraping", () => {
    const digest = previousDailyDigest({
      previousPath: "wiki/dailies/2026-02-27.md",
      previousContent: [
        "# 2026-02-27",
        "",
        "## Decisions",
        "",
        "- Keep alpha review in the weekly plan.",
        "",
        "## Done",
        "",
        "- Hand-written bullet outside the block is not scraped.",
        "",
        "<!-- dome.daily:close:start -->",
        "### Done today",
        "Candidates from today's settles — keep what counts, delete the rest.",
        "- Sent Ada the staffing note (from [[wiki/projects/alpha]])",
        "- Booked the offsite room",
        "### Still open",
        "- 1 loop still open — top: Draft the rollout plan",
        "### Story of the Day",
        "The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.",
        "<!-- dome.daily:close:end -->",
        "",
        "## Story of the Day",
        "",
        "The staffing packet landed.",
        "",
      ].join("\n"),
    });
    expect(digest.done).toEqual([
      "Sent Ada the staffing note (from [[wiki/projects/alpha]])",
      "Booked the offsite room",
    ]);
    expect(digest.close).toEqual({
      kept: [
        "Sent Ada the staffing note (from [[wiki/projects/alpha]])",
        "Booked the offsite room",
      ],
      stillOpenCount: 1,
    });

    const section = yesterdayFallbackSection(digest);
    expect(section).toBe(
      [
        "<!-- dome.agent.brief:yesterday:start -->",
        "### Yesterday",
        "- Previous daily: [[wiki/dailies/2026-02-27]]",
        "- Done yesterday: Sent Ada the staffing note (from [[wiki/projects/alpha]]); Booked the offsite room",
        "- Still open at close: 1 loop carried.",
        "- Decisions yesterday: Keep alpha review in the weekly plan.",
        "- Story: The staffing packet landed.",
        "<!-- dome.agent.brief:yesterday:end -->",
      ].join("\n"),
    );
    expect(section).not.toContain("Hand-written bullet");
    expect(section).not.toContain("keep what counts");
  });

  test("an empty close degrades to the explicit 'yesterday's close was empty' line", () => {
    const digest = previousDailyDigest({
      previousPath: "wiki/dailies/2026-02-27.md",
      previousContent: [
        "# 2026-02-27",
        "",
        "## Done",
        "",
        "<!-- dome.daily:close:start -->",
        "### Done today",
        "Nothing recorded as settled today.",
        "### Still open",
        "- 2 loops still open — top: Draft the rollout plan; Review the audit findings",
        "### Story of the Day",
        "The story stays yours — write it in the ## Story of the Day section below; the close never generates prose.",
        "<!-- dome.daily:close:end -->",
        "",
      ].join("\n"),
    });
    const section = yesterdayFallbackSection(digest);
    expect(section).toContain("- Yesterday's close was empty.");
    expect(section).toContain("- Still open at close: 2 loops carried.");
    expect(section).not.toContain("- Done yesterday:");
  });

  test("a missing close falls back to raw section scraping (pre-D4 behavior, unchanged)", () => {
    const digest = previousDailyDigest({
      previousPath: "wiki/dailies/2026-02-27.md",
      previousContent: [
        "# 2026-02-27",
        "",
        "## Done",
        "",
        "- Sent Ada the staffing note.",
        "",
      ].join("\n"),
    });
    expect(digest.close).toBeNull();
    const section = yesterdayFallbackSection(digest);
    expect(section).toContain(
      "- Done yesterday: Sent Ada the staffing note.",
    );
    expect(section).not.toContain("Still open at close");
    expect(section).not.toContain("close was empty");
  });

  test("settledActionItemsFromMarkdown extracts direct settles only", () => {
    const content = [
      "## Notes",
      "",
      "- [x] Booked the offsite room ^t1234abcd",
      "- [-] Dropped the vendor call",
      "- [ ] Still open stays out",
      "- [x] Sent Ada the staffing note (from [[wiki/projects/alpha]])",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "- [x] Inside a generated block stays out",
      "<!-- dome.daily:open-loops:end -->",
      "",
      "```",
      "- [x] Inside a fence stays out",
      "```",
      "",
    ].join("\n");
    expect(settledActionItemsFromMarkdown(content)).toEqual([
      { line: 3, body: "Booked the offsite room", status: "resolved" },
      { line: 4, body: "Dropped the vendor call", status: "dismissed" },
    ]);
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

  test("the unified yesterday block is excluded from task extraction (fallback prose never re-ingests)", () => {
    const content = [
      "TODO: Keep source item",
      "<!-- dome.agent.brief:yesterday:start -->",
      "### Yesterday",
      "- Done yesterday: Follow up with Sam about hiring",
      "- [ ] Generated checkbox should not become source",
      "<!-- dome.agent.brief:yesterday:end -->",
    ].join("\n");
    expect(actionItemsFromMarkdown(content).map((item) => item.body)).toEqual([
      "Keep source item",
    ]);
    // The compressed Done line contains "follow up with" prose — inside the
    // generated block it must not raise an ambiguous-followup question.
    expect(ambiguousFollowupsFromMarkdown(content)).toEqual([]);
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

  test("openLoopFreshnessKey ranks daily notes by daily date", () => {
    const settings = dailyPathSettings({ daily_path: "notes/{date}.md" });

    expect(
      openLoopFreshnessKey({
        path: "notes/2026-05-28.md",
        settings,
        lastChangedAt: "2026-06-02T16:56:19.000Z",
      }),
    ).toBe("2026-05-28T00:00:00.000Z");

    expect(
      openLoopFreshnessKey({
        path: "wiki/projects/alpha.md",
        settings,
        lastChangedAt: "2026-06-02T16:56:19.000Z",
      }),
    ).toBe("2026-06-02T16:56:19.000Z");
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

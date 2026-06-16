// `## Captured today` — the owned capture landing zone (daily-surface D3).
//
// Pins, per [[wiki/specs/daily-surface]] §"Block ownership" + §"The
// `captured` block holds origins, not copies":
//   - the skeleton renders the section first, above `## Start Here`, with an
//     empty `dome.daily:captured` block;
//   - the splice/validation helpers behind the ingest tool seam;
//   - the captured-today heading repair (merge, anchors preserved,
//     idempotent, historical dailies untouched);
//   - the ORIGIN-not-copy distinction: captured lines stay inside task
//     extraction/stamping/surfacing, and a captured task settled in place is
//     never treated as a carry-forward copy.

import { describe, expect, test } from "bun:test";

import normalizeTaskSyntaxProcessor from "../../assets/extensions/dome.daily/processors/normalize-task-syntax";
import taskIndex from "../../assets/extensions/dome.daily/processors/task-index";
import {
  actionItemsFromMarkdown,
  appendOriginMarker as appendOriginMarkerPrimitive,
  parseOriginMarker,
  settledActionItemsFromMarkdown,
  sourceBackedCheckboxFromLine,
  stampTaskAnchors,
  stripOriginMarker,
  stripOriginMarker as stripOriginMarkerPrimitive,
} from "../../assets/extensions/dome.daily/processors/action-extraction";
import {
  appendCapturedTaskLines,
  appendOriginMarker,
  capturedBlockBodyLines,
  CAPTURED_APPEND_MAX_LINES,
  CAPTURED_LINE_MAX_CHARS,
  isCapturedTaskLine,
  isValidCapturedTasksWrite,
  repairCapturedTodayHeadings,
} from "../../assets/extensions/dome.daily/processors/captured-block";
import { dailyPath, dailyPathSettings, localDateParts } from "../../assets/extensions/dome.daily/processors/daily-paths";
import { renderDailySkeleton } from "../../assets/extensions/dome.daily/processors/daily-scaffold";
import { CAPTURED_END, CAPTURED_START } from "../../assets/extensions/dome.daily/processors/daily-types";
import {
  openLoopSurfaceSources,
  reconcileSettledOpenLoops,
  settledSourceBackedOpenLoopsFromMarkdown,
} from "../../assets/extensions/dome.daily/processors/open-loop-surface";
import type { DiagnosticEffect, FactEffect, PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("6666666666666666666666666666666666666666");
const TREE = treeOid("7777777777777777777777777777777777777777");
const NOW = new Date("2026-06-05T15:00:00.000Z");
const TODAY_PATH = dailyPath(localDateParts(NOW), dailyPathSettings(undefined));

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined ? null : { lastChangedAt: NOW.toISOString() },
  }) as unknown as Snapshot;
}

function ctxFor(
  files: Readonly<Record<string, string>>,
  changedPaths: ReadonlyArray<string>,
) {
  return makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths,
    proposal: null,
    runId: "run-captured",
    signal: new AbortController().signal,
    input: { kind: "signal" },
    now: NOW,
  });
}

describe("renderDailySkeleton — Captured today section", () => {
  const skeleton = renderDailySkeleton({
    today: { yyyy: "2026", mm: "02", dd: "28" },
    yesterday: { yyyy: "2026", mm: "02", dd: "27" },
  });

  test("renders Captured today as the first content section, above Start Here", () => {
    const captured = skeleton.indexOf("## Captured today");
    const startHere = skeleton.indexOf("## Start Here");
    const title = skeleton.indexOf("# 2026-02-28");
    expect(captured).toBeGreaterThan(title);
    expect(startHere).toBeGreaterThan(captured);
  });

  test("the section hosts an empty dome.daily:captured block (markers + hint only)", () => {
    expect(skeleton).toContain(CAPTURED_START);
    expect(skeleton).toContain(CAPTURED_END);
    const body = skeleton.slice(
      skeleton.indexOf(CAPTURED_START) + CAPTURED_START.length,
      skeleton.indexOf(CAPTURED_END),
    );
    // Hint comment only — no task lines, nothing extractable.
    expect(body.trim().startsWith("<!--")).toBe(true);
    expect(actionItemsFromMarkdown(skeleton)).toEqual([]);
  });
});

describe("isCapturedTaskLine", () => {
  test("accepts open #task / #followup checkbox lines", () => {
    expect(isCapturedTaskLine("- [ ] #task call the landlord")).toBe(true);
    expect(isCapturedTaskLine("- [ ] chase the invoice #followup")).toBe(true);
    expect(isCapturedTaskLine("* [ ] #task starred form 📅 2026-06-10")).toBe(true);
  });

  test("rejects non-task shapes", () => {
    expect(isCapturedTaskLine("just prose")).toBe(false);
    expect(isCapturedTaskLine("- [ ] no tag at all")).toBe(false);
    expect(isCapturedTaskLine("- [x] #task already settled")).toBe(false);
    expect(isCapturedTaskLine("todo: directive form #task")).toBe(false);
    expect(isCapturedTaskLine("## Captured today")).toBe(false);
  });

  test("rejects a line over the per-line char cap; accepts one exactly at it", () => {
    const prefix = "- [ ] #task ";
    const atCap = prefix + "x".repeat(CAPTURED_LINE_MAX_CHARS - prefix.length);
    expect(atCap.length).toBe(CAPTURED_LINE_MAX_CHARS);
    expect(isCapturedTaskLine(atCap)).toBe(true);
    expect(isCapturedTaskLine(`${atCap}x`)).toBe(false);
  });

  test("rejects U+2028/U+2029 (LS/PS are line boundaries to m-flag regexes)", () => {
    // A smuggled LS + `## Done ` would read as its own line to every
    // `m`-flag heading-anchor regex — a phantom insertion anchor for later
    // heading-anchored splices.
    expect(
      isCapturedTaskLine("- [ ] #task sneak\u2028## Done\u2028more #task"),
    ).toBe(false);
    expect(isCapturedTaskLine("- [ ] #task sneak\u2029## Done")).toBe(false);
  });

  test("rejects marker injection and copy-shaped lines", () => {
    expect(
      isCapturedTaskLine("- [ ] #task sneak <!-- dome.daily:captured:end -->"),
    ).toBe(false);
    expect(isCapturedTaskLine("- [ ] #task half a comment -->")).toBe(false);
    // A `(from [[origin]])` suffix is the carry-forward COPY shape; a
    // captured line is an origin and must never masquerade as a copy.
    expect(
      isCapturedTaskLine("- [ ] #task chase it (from [[wiki/projects/x]])"),
    ).toBe(false);
  });
});

describe("appendCapturedTaskLines", () => {
  test("splices inside an existing block, before the end marker", () => {
    const skeleton = renderDailySkeleton({
      today: { yyyy: "2026", mm: "02", dd: "28" },
      yesterday: null,
    });
    const next = appendCapturedTaskLines({
      content: skeleton,
      lines: ["- [ ] #task call the landlord"],
    });
    const start = next.indexOf(CAPTURED_START);
    const end = next.indexOf(CAPTURED_END);
    const task = next.indexOf("- [ ] #task call the landlord");
    expect(task).toBeGreaterThan(start);
    expect(task).toBeLessThan(end);
    // A second append accumulates after the first, still inside the block.
    const again = appendCapturedTaskLines({
      content: next,
      lines: ["- [ ] #task buy stamps"],
    });
    const second = again.indexOf("- [ ] #task buy stamps");
    expect(second).toBeGreaterThan(again.indexOf("- [ ] #task call the landlord"));
    expect(second).toBeLessThan(again.indexOf(CAPTURED_END));
  });

  test("creates the block under an existing bare heading", () => {
    const content = "# 2026-02-28\n\n## Captured today\n\n## Notes\n";
    const next = appendCapturedTaskLines({
      content,
      lines: ["- [ ] #task call the landlord"],
    });
    expect(next.indexOf(CAPTURED_START)).toBeGreaterThan(
      next.indexOf("## Captured today"),
    );
    expect(next.indexOf(CAPTURED_END)).toBeLessThan(next.indexOf("## Notes"));
  });

  test("creates heading + block before Start Here when the section is absent", () => {
    const content = "# 2026-02-28\n\n## Start Here\n\n## Notes\n";
    const next = appendCapturedTaskLines({
      content,
      lines: ["- [ ] #task call the landlord"],
    });
    expect(next.indexOf("## Captured today")).toBeLessThan(
      next.indexOf("## Start Here"),
    );
    expect(next.indexOf("- [ ] #task call the landlord")).toBeLessThan(
      next.indexOf("## Start Here"),
    );
  });

  test("appends a new section at EOF when no anchor heading exists", () => {
    const next = appendCapturedTaskLines({
      content: "# loose page\n",
      lines: ["- [ ] #task call the landlord"],
    });
    expect(next).toContain("## Captured today");
    expect(next.indexOf(CAPTURED_END)).toBeGreaterThan(
      next.indexOf("- [ ] #task call the landlord"),
    );
  });
});

describe("isValidCapturedTasksWrite", () => {
  const before = renderDailySkeleton({
    today: { yyyy: "2026", mm: "02", dd: "28" },
    yesterday: null,
  });

  test("accepts a rewrite that only appends task lines inside the block", () => {
    const after = appendCapturedTaskLines({
      content: before,
      lines: ["- [ ] #task call the landlord"],
    });
    expect(isValidCapturedTasksWrite({ before, after })).toBe(true);
  });

  test("rejects edits outside the block", () => {
    const after = `${before}\nfree prose at the end\n`;
    expect(isValidCapturedTasksWrite({ before, after })).toBe(false);
  });

  test("rejects non-task lines appended inside the block", () => {
    const after = appendCapturedTaskLines({
      content: before,
      lines: ["a stray prose line"],
    });
    expect(isValidCapturedTasksWrite({ before, after })).toBe(false);
  });

  test("rejects when the before content lacks the block (append seam owns creation)", () => {
    const bare = "# 2026-02-28\n\n## Notes\n";
    const after = appendCapturedTaskLines({
      content: bare,
      lines: ["- [ ] #task call the landlord"],
    });
    expect(isValidCapturedTasksWrite({ before: bare, after })).toBe(false);
  });

  test("caps the appended line count (the rewrite path is not a bulk-import bypass)", () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `- [ ] #task item ${i}`);
    const atCap = appendCapturedTaskLines({
      content: before,
      lines: lines(CAPTURED_APPEND_MAX_LINES),
    });
    expect(isValidCapturedTasksWrite({ before, after: atCap })).toBe(true);
    const overCap = appendCapturedTaskLines({
      content: before,
      lines: lines(CAPTURED_APPEND_MAX_LINES + 1),
    });
    expect(isValidCapturedTasksWrite({ before, after: overCap })).toBe(false);
  });

  test("rejects a body rewrite that drops existing block content", () => {
    const seeded = appendCapturedTaskLines({
      content: before,
      lines: ["- [ ] #task call the landlord"],
    });
    expect(isValidCapturedTasksWrite({ before: seeded, after: before })).toBe(
      false,
    );
  });
});

describe("repairCapturedTodayHeadings", () => {
  test("merges duplicate mismatched-level headings into the single owned section", () => {
    const skeleton = renderDailySkeleton({
      today: { yyyy: "2026", mm: "06", dd: "05" },
      yesterday: null,
    });
    const content = [
      skeleton,
      "# Captured today",
      "",
      "- [ ] #task stray capture one ^t11111111",
      "",
      "## Captured today",
      "- [ ] #task stray capture two",
      "",
    ].join("\n");

    const repaired = repairCapturedTodayHeadings(content);
    expect(repaired).not.toBeNull();
    // One heading remains, normalized to level 2.
    const headings = repaired!
      .split("\n")
      .filter((line) => /^#{1,6}\s+captured\s+today\s*$/i.test(line));
    expect(headings).toEqual(["## Captured today"]);
    // Both task lines preserved verbatim (anchor included), inside the block.
    const start = repaired!.indexOf(CAPTURED_START);
    const end = repaired!.indexOf(CAPTURED_END);
    const one = repaired!.indexOf("- [ ] #task stray capture one ^t11111111");
    const two = repaired!.indexOf("- [ ] #task stray capture two");
    expect(one).toBeGreaterThan(start);
    expect(one).toBeLessThan(end);
    expect(two).toBeGreaterThan(start);
    expect(two).toBeLessThan(end);
    // Idempotent: a second run is the fixed point.
    expect(repairCapturedTodayHeadings(repaired!)).toBeNull();
  });

  test("merges duplicates even when no block exists yet (pre-D3 daily)", () => {
    const content = [
      "# 2026-06-05",
      "",
      "# Captured today",
      "- [ ] #task first",
      "",
      "## Captured today",
      "- [ ] #task second ^tabcdef12",
      "",
      "## Notes",
      "",
    ].join("\n");
    const repaired = repairCapturedTodayHeadings(content);
    expect(repaired).not.toBeNull();
    expect(repaired!).toContain(CAPTURED_START);
    expect(repaired!).toContain("- [ ] #task first");
    expect(repaired!).toContain("- [ ] #task second ^tabcdef12");
    expect(
      repaired!.split("\n").filter((l) => /captured today/i.test(l) && l.startsWith("#")),
    ).toHaveLength(1);
    expect(repairCapturedTodayHeadings(repaired!)).toBeNull();
  });

  test("normalizes a single wrong-level heading", () => {
    const content = "# 2026-06-05\n\n# Captured today\n\n- [ ] #task x\n";
    const repaired = repairCapturedTodayHeadings(content);
    expect(repaired).not.toBeNull();
    expect(repaired!).toContain("## Captured today");
    expect(repaired!).toContain("- [ ] #task x");
    expect(repairCapturedTodayHeadings(repaired!)).toBeNull();
  });

  test("drops smuggled dome marker lines from merged sections", () => {
    const skeleton = renderDailySkeleton({
      today: { yyyy: "2026", mm: "06", dd: "05" },
      yesterday: null,
    });
    const content = [
      skeleton,
      "## Captured today",
      "- [ ] #task real line",
      "<!-- dome.daily:captured:end -->",
      "",
    ].join("\n");
    const repaired = repairCapturedTodayHeadings(content);
    expect(repaired).not.toBeNull();
    expect(repaired!).toContain("- [ ] #task real line");
    // Exactly one marker pair survives.
    expect(
      repaired!.split("\n").filter((l) => l.trim() === CAPTURED_END),
    ).toHaveLength(1);
  });

  test("is a no-op for a clean daily and for pages without the section", () => {
    const skeleton = renderDailySkeleton({
      today: { yyyy: "2026", mm: "06", dd: "05" },
      yesterday: null,
    });
    expect(repairCapturedTodayHeadings(skeleton)).toBeNull();
    expect(repairCapturedTodayHeadings("# plain page\n\nprose\n")).toBeNull();
  });
});

describe("normalize-task-syntax carries the repair for TODAY's daily only", () => {
  const duplicated = [
    "# daily",
    "",
    "# Captured today",
    "- [ ] #task stray one",
    "",
    "## Captured today",
    "- [ ] #task stray two",
    "",
  ].join("\n");

  test("repairs today's daily and emits one info diagnostic", async () => {
    const ctx = ctxFor({ [TODAY_PATH]: duplicated }, [TODAY_PATH]);
    const effects = await normalizeTaskSyntaxProcessor.run(ctx);
    const diagnostics = effects.filter(
      (e): e is DiagnosticEffect => e.kind === "diagnostic",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe("info");
    expect(diagnostics[0]?.code).toBe("dome.daily.captured-heading-repair");
    const patch = effects.find((e): e is PatchEffect => e.kind === "patch");
    expect(patch).toBeDefined();
    const change = patch!.changes.find((c) => String(c.path) === TODAY_PATH);
    expect(change?.kind).toBe("write");
    const content = change?.kind === "write" ? change.content : "";
    expect(content).toContain(CAPTURED_START);
    expect(content).toContain("- [ ] #task stray one");
    expect(content).toContain("- [ ] #task stray two");
    expect(
      content.split("\n").filter((l) => /^#{1,6}\s+captured\s+today\s*$/i.test(l)),
    ).toEqual(["## Captured today"]);
  });

  test("leaves a historical daily with the same wart untouched", async () => {
    const historicalPath = "wiki/dailies/2026-06-01.md";
    const ctx = ctxFor({ [historicalPath]: duplicated }, [historicalPath]);
    const effects = await normalizeTaskSyntaxProcessor.run(ctx);
    expect(effects).toEqual([]);
  });
});

describe("captured tasks are origins, not copies", () => {
  const daily = [
    "---",
    "type: daily",
    "---",
    "",
    "# 2026-06-05",
    "",
    "## Captured today",
    "",
    CAPTURED_START,
    "- [ ] #task call the landlord",
    "- [x] #task settled in place ^tfeedface",
    CAPTURED_END,
    "",
    "## Open Loops",
    "",
    "<!-- dome.daily:open-loops:start -->",
    "- [ ] surfaced copy (from [[wiki/projects/x]])",
    "<!-- dome.daily:open-loops:end -->",
    "",
  ].join("\n");

  test("task extraction includes captured-block lines but not open-loops copies", () => {
    const bodies = actionItemsFromMarkdown(daily).map((item) => item.body);
    expect(bodies).toContain("call the landlord");
    expect(bodies).not.toContain("surfaced copy");
  });

  test("stampTaskAnchors stamps the captured line", () => {
    const stamped = stampTaskAnchors({ path: TODAY_PATH, content: daily });
    expect(stamped).not.toBeNull();
    expect(stamped!).toMatch(/- \[ \] #task call the landlord \^t[0-9a-f]{8}/);
  });

  test("task-index projects a captured line into an open_task fact", async () => {
    const ctx = ctxFor({ [TODAY_PATH]: daily }, [TODAY_PATH]);
    const effects = await taskIndex.run(ctx);
    const facts = effects.filter((e): e is FactEffect => e.kind === "fact");
    expect(
      facts.some(
        (fact) =>
          fact.predicate === "dome.daily.open_task" &&
          fact.object.kind === "string" &&
          fact.object.value === "call the landlord",
      ),
    ).toBe(true);
  });

  test("a settled captured task is NOT a settled carry-forward copy", () => {
    // No `(from [[…]])` suffix → never collected as a settled copy …
    const settled = settledSourceBackedOpenLoopsFromMarkdown({
      path: TODAY_PATH,
      content: daily,
    });
    expect(settled.map((item) => item.body)).not.toContain("settled in place");
    // … so reconcile has nothing to propagate and the line stays settled
    // exactly where it is.
    const rewrites = reconcileSettledOpenLoops({
      files: [{ path: TODAY_PATH, content: daily }],
    });
    expect(rewrites).toEqual([]);
  });

  test("captured open tasks surface as open-loop sources (origins ranked into future dailies)", () => {
    const sources = openLoopSurfaceSources({
      path: TODAY_PATH,
      content: daily,
    });
    expect(sources.map((item) => item.body)).toContain("call the landlord");
    // The open-loops copy inside the generated block is NOT a source.
    expect(sources.map((item) => item.body)).not.toContain("surfaced copy");
  });
});

describe("stripOriginMarker", () => {
  test("removes a trailing origin marker, leaving the body", () => {
    expect(stripOriginMarker("reply to Jane ([↗](inbox/processed/x.md))")).toBe("reply to Jane");
  });
  test("preserves user parentheses, stripping only the marker", () => {
    expect(
      stripOriginMarker("call Bob (re: the (nested) thing) ([↗](inbox/processed/x.md))"),
    ).toBe("call Bob (re: the (nested) thing)");
  });
  test("a body with no marker is unchanged", () => {
    expect(stripOriginMarker("plain body")).toBe("plain body");
  });
});

describe("settledActionItemsFromMarkdown strips the origin marker", () => {
  test("settled captured task body does not contain the origin marker", () => {
    const content = [
      "## Captured today",
      "",
      "<!-- dome.daily:captured:start -->",
      "- [x] #task reply to Jane ([↗](inbox/processed/2026-06-14-jane.md)) ^t1a2b3c4d",
      "<!-- dome.daily:captured:end -->",
      "",
    ].join("\n");
    const settled = settledActionItemsFromMarkdown(content);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.body).toBe("reply to Jane");
    expect(settled[0]?.body).not.toContain("↗");
    expect(settled[0]?.body).not.toContain("inbox/processed");
  });
});

describe("appendOriginMarker", () => {
  test("appends a clickable marker to a bare task line", () => {
    expect(
      appendOriginMarker("- [ ] #task reply to Jane", "inbox/processed/2026-06-14-jane.md"),
    ).toBe("- [ ] #task reply to Jane ([↗](inbox/processed/2026-06-14-jane.md))");
  });

  test("places the marker before a trailing block anchor", () => {
    expect(
      appendOriginMarker("- [ ] #task reply to Jane ^a1b2", "inbox/processed/x.md"),
    ).toBe("- [ ] #task reply to Jane ([↗](inbox/processed/x.md)) ^a1b2");
  });

  test("is idempotent — a line already carrying a marker is unchanged", () => {
    const already = "- [ ] #task reply ([↗](inbox/processed/x.md))";
    expect(appendOriginMarker(already, "inbox/processed/y.md")).toBe(already);
  });

  test("an empty target leaves the line unchanged", () => {
    expect(appendOriginMarker("- [ ] #task reply", "")).toBe("- [ ] #task reply");
  });

  test("a marker-bearing line is still a valid captured task line", () => {
    const line = appendOriginMarker("- [ ] #task reply", "inbox/processed/x.md");
    expect(isCapturedTaskLine(line)).toBe(true);
  });

  test("idempotent even when the target contains a close-paren", () => {
    const target = "https://x.example/a(b)";
    const once = appendOriginMarker("- [ ] #task reply", target);
    expect(appendOriginMarker(once, target)).toBe(once);
  });
});

describe("sourceBackedCheckboxFromLine strips the origin marker from body", () => {
  test("body does not contain the ↗ marker even when the carry-forward copy line carries one", () => {
    // A carry-forward copy of a captured (Slack-origin) task can arrive with
    // the inline origin marker still in the text — the strip must happen so
    // the body that enters reconcile re-keying matches the stripped body from
    // the source note.
    const line =
      "- [ ] #task reply to Jane ([↗](inbox/processed/2026-06-14-jane.md)) (from [[wiki/projects/alpha]])";
    const result = sourceBackedCheckboxFromLine(line, 1);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("reply to Jane");
    expect(result!.body).not.toContain("↗");
    expect(result!.body).not.toContain("inbox/processed");
    // sourcePath and followup are unaffected
    expect(result!.sourcePath).toBe("wiki/projects/alpha.md");
    expect(result!.followup).toBe(false);
  });

  test("body without a marker is passed through unchanged", () => {
    const line = "- [ ] plain task (from [[wiki/projects/beta]])";
    const result = sourceBackedCheckboxFromLine(line, 5);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("plain task");
  });
});

describe("origin marker primitive", () => {
  test("append + parse round-trips a plain vault path", () => {
    const line = appendOriginMarkerPrimitive("- [ ] #task fix it", "inbox/processed/x.md");
    expect(line).toBe("- [ ] #task fix it ([↗](inbox/processed/x.md))");
    expect(parseOriginMarker(line)).toEqual({ body: "- [ ] #task fix it", target: "inbox/processed/x.md" });
  });
  test("percent-encodes ( and ) in the target so a URL with parens is safe", () => {
    const url = "https://x.example/a(b)";
    const line = appendOriginMarkerPrimitive("- [ ] #task reply", url);
    expect(line).toContain("%28");
    expect(line).toContain("%29");
    expect(parseOriginMarker(line)!.target).toBe(url);
    expect(stripOriginMarkerPrimitive(line)).toBe("- [ ] #task reply");
  });
  test("strip on a marker-free line is a no-op", () => {
    expect(stripOriginMarkerPrimitive("- [ ] #task plain")).toBe("- [ ] #task plain");
  });
  test("append is idempotent (line already carrying a marker is unchanged)", () => {
    const once = appendOriginMarkerPrimitive("- [ ] #task reply", "inbox/processed/x.md");
    expect(appendOriginMarkerPrimitive(once, "inbox/processed/y.md")).toBe(once);
  });
  test("round-trips a target that already contains a percent-encoded sequence", () => {
    const url = "https://x.example/a%28b%29c";
    const line = appendOriginMarkerPrimitive("- [ ] #task reply", url);
    expect(parseOriginMarker(line)!.target).toBe(url);
    expect(stripOriginMarkerPrimitive(line)).toBe("- [ ] #task reply");
  });
});

describe("action items carry origin", () => {
  test("a captured task exposes its origin target, body stays marker-free", () => {
    const md = "## Captured today\n\n- [ ] #task reply to Jane ([↗](https://uniswapteam.slack.com/archives/C0/p1)) ^t1a2b3c4\n";
    const items = actionItemsFromMarkdown(md);
    const item = items.find((i) => i.body.includes("reply to Jane"))!;
    expect(item.body).toBe("reply to Jane");
    expect(item.origin).toBe("https://uniswapteam.slack.com/archives/C0/p1");
  });
  test("a task with no marker has undefined origin", () => {
    const md = "- [ ] #task plain ^t9z9z9z9\n";
    const items = actionItemsFromMarkdown(md);
    expect(items[0]!.origin).toBeUndefined();
  });
});

describe("capturedBlockBodyLines", () => {
  test("returns the non-blank body lines of a block with two task lines", () => {
    // Build a minimal document with only two task lines inside the block (no
    // hint comment) so the result is deterministic regardless of skeleton shape.
    const content = [
      "## Captured today",
      "",
      CAPTURED_START,
      "- [ ] #task first task",
      "- [ ] #task second task",
      CAPTURED_END,
      "",
    ].join("\n");
    const lines = capturedBlockBodyLines(content);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("- [ ] #task first task");
    expect(lines[1]).toBe("- [ ] #task second task");
  });

  test("returns the hint comment for a skeleton whose block is otherwise empty", () => {
    const skeleton = renderDailySkeleton({
      today: { yyyy: "2026", mm: "06", dd: "15" },
      yesterday: null,
    });
    // The skeleton block contains exactly one non-blank line: the hint comment.
    const lines = capturedBlockBodyLines(skeleton);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^<!--.*ingest.*-->$/i);
  });

  test("returns [] when the captured block is absent", () => {
    const content = "# 2026-06-15\n\n## Start Here\n\n## Notes\n";
    expect(capturedBlockBodyLines(content)).toEqual([]);
  });
});

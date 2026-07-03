// dome.search.index-text — section splitter + section-granular effect tests.
//
// Per [[wiki/specs/effects]] §SearchDocumentEffect and
// [[wiki/specs/projection-store]] §"fts_documents": pages split at H2
// headings into breadcrumbed sections (intro before the first H2, sub-splits
// for over-long sections), the processor emits one page `delete` followed by
// one `upsert` per section, generated surface blocks stay stripped, and
// re-running on unchanged content emits the same effect sequence
// (idempotent re-index).

import { describe, expect, test } from "bun:test";

import searchIndexText, {
  splitIntoSections,
} from "../../assets/extensions/dome.search/processors/index-text";
import type { SearchDocumentEffect } from "../../src/core/effect";
import {
  treeOid,
  type ProcessorContext,
  type Snapshot,
} from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

// ----- splitIntoSections -----------------------------------------------------

describe("splitIntoSections", () => {
  test("headingless page yields a single intro section", () => {
    const sections = splitIntoSections({
      title: "Plain Page",
      body: "# Plain Page\n\nJust prose, no H2 headings.",
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe("intro");
    expect(sections[0]?.breadcrumb).toBe("Plain Page");
    expect(sections[0]?.startLine).toBe(1);
    expect(sections[0]?.endLine).toBe(3);
  });

  test("empty body still yields the intro section", () => {
    const sections = splitIntoSections({ title: "Empty", body: "" });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe("intro");
  });

  test("splits at H2 with breadcrumbed heading paths and line ranges", () => {
    const sections = splitIntoSections({
      title: "Project Alpha",
      body: [
        "# Project Alpha", // 1
        "", // 2
        "Intro prose.", // 3
        "", // 4
        "## Rollout Plan", // 5
        "", // 6
        "Phase one ships first.", // 7
        "", // 8
        "## Open Questions", // 9
        "", // 10
        "Who owns the launch?", // 11
      ].join("\n"),
    });
    expect(sections.map((s) => s.id)).toEqual([
      "intro",
      "rollout-plan",
      "open-questions",
    ]);
    expect(sections.map((s) => s.breadcrumb)).toEqual([
      "Project Alpha",
      "Project Alpha › Rollout Plan",
      "Project Alpha › Open Questions",
    ]);
    expect(sections[1]?.startLine).toBe(5);
    expect(sections[1]?.endLine).toBe(8);
    expect(sections[2]?.startLine).toBe(9);
    expect(sections[2]?.endLine).toBe(11);
    expect(sections[1]?.body).toContain("## Rollout Plan");
    expect(sections[1]?.body).toContain("Phase one ships first.");
  });

  test("skips an empty intro when the page starts at its first H2", () => {
    const sections = splitIntoSections({
      title: "No Intro",
      body: "## First\n\ncontent\n",
    });
    expect(sections.map((s) => s.id)).toEqual(["first"]);
  });

  test("duplicate headings get ordinal-deduped section ids", () => {
    const sections = splitIntoSections({
      title: "Log",
      body: "intro\n\n## Notes\n\na\n\n## Notes\n\nb\n\n## Intro\n\nc\n",
    });
    expect(sections.map((s) => s.id)).toEqual([
      "intro",
      "notes",
      "notes-2",
      "intro-2",
    ]);
  });

  test("H2 lines inside code fences do not split", () => {
    const sections = splitIntoSections({
      title: "Fenced",
      body: [
        "intro",
        "",
        "```md",
        "## Not A Heading",
        "```",
        "",
        "## Real Heading",
        "",
        "body",
      ].join("\n"),
    });
    expect(sections.map((s) => s.id)).toEqual(["intro", "real-heading"]);
    expect(sections[0]?.body).toContain("## Not A Heading");
  });

  test("heading slugs strip wikilinks, markdown links, and formatting", () => {
    const sections = splitIntoSections({
      title: "T",
      body: "x\n\n## `Code` and [[wiki/page|Display]] and [text](http://x)\n\nb\n",
    });
    expect(sections.map((s) => s.id)).toEqual([
      "intro",
      "code-and-display-and-text",
    ]);
  });

  test("sub-splits over-long sections at paragraph boundaries", () => {
    const paragraph = `${"alpha beta gamma ".repeat(40).trim()}.`; // ~680 chars
    const body = [
      "intro",
      "",
      "## Big Section",
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
      "",
      paragraph,
    ].join("\n");
    const sections = splitIntoSections({ title: "T", body });
    const big = sections.filter((s) => s.id.startsWith("big-section"));
    expect(big.length).toBeGreaterThan(1);
    expect(big.map((s) => s.id)).toEqual(
      big.map((_, i) => (i === 0 ? "big-section" : `big-section~${i + 1}`)),
    );
    // Continuation parts share the breadcrumb; no part exceeds the cap by a
    // whole paragraph.
    for (const part of big) {
      expect(part.breadcrumb).toBe("T › Big Section");
      expect(part.body.length).toBeLessThanOrEqual(2_048 + paragraph.length);
    }
    // Paragraphs are not mangled across parts.
    expect(big.map((s) => s.body).join("\n\n")).toContain(paragraph);
  });

  test("does not sub-split inside code fences", () => {
    // The fence interior contains blank lines; only blank lines OUTSIDE the
    // fence are paragraph boundaries, so the whole fence must land intact in
    // a single part even though it exceeds the sub-split budget.
    const fenceBody = `\`\`\`\n${"line\n\n".repeat(500)}\`\`\``; // > 2048 chars
    const sections = splitIntoSections({
      title: "T",
      body: `intro\n\n## Fence\n\n${fenceBody}\n`,
    });
    const fence = sections.filter((s) => s.id.startsWith("fence"));
    const withFence = fence.filter((s) => s.body.includes("```"));
    expect(withFence).toHaveLength(1);
    expect(withFence[0]?.body).toContain(fenceBody);
  });

  test("applies the body line offset for frontmatter-shifted anchors", () => {
    const sections = splitIntoSections({
      title: "T",
      body: "x\n\n## A\n\nb",
      lineOffset: 4,
    });
    expect(sections[1]?.startLine).toBe(7);
  });
});

// ----- processor run ---------------------------------------------------------

function makeSnapshot(files: ReadonlyMap<string, string>): Snapshot {
  return Object.freeze({
    commit: commitOid("1111111111111111111111111111111111111111"),
    tree: treeOid("2222222222222222222222222222222222222222"),
    readFile: async (path: string) => files.get(path) ?? null,
    listMarkdownFiles: async () =>
      Object.freeze([...files.keys()].filter((p) => p.endsWith(".md"))),
    getFileInfo: async () => null,
  });
}

function makeContext(
  files: ReadonlyMap<string, string>,
  changedPaths: ReadonlyArray<string>,
): ProcessorContext {
  return makeProcessorContext({
    snapshot: makeSnapshot(files),
    changedPaths,
    proposal: null,
    runId: "run-1",
    input: undefined,
    signal: new AbortController().signal,
  });
}

function asSearchEffects(
  effects: ReadonlyArray<unknown>,
): ReadonlyArray<SearchDocumentEffect> {
  return effects as ReadonlyArray<SearchDocumentEffect>;
}

describe("dome.search.index-text", () => {
  const page = [
    "---",
    "type: project",
    "title: Project Alpha",
    "---",
    "# Project Alpha",
    "",
    "Intro prose about the launch.",
    "",
    "## Rollout Plan",
    "",
    "Phase one ships first.",
  ].join("\n");

  test("emits a page delete followed by breadcrumbed section upserts", async () => {
    const files = new Map([["wiki/alpha.md", page]]);
    const effects = asSearchEffects(
      await searchIndexText.run(makeContext(files, ["wiki/alpha.md"])),
    );

    expect(effects.map((e) => e.operation)).toEqual([
      "delete",
      "upsert",
      "upsert",
    ]);
    const sections = effects.filter((e) => e.operation === "upsert");
    expect(sections.map((e) => e.operation === "upsert" ? e.sectionId : null))
      .toEqual(["intro", "rollout-plan"]);
    const rollout = sections[1];
    if (rollout?.operation !== "upsert") throw new Error("expected upsert");
    expect(rollout.breadcrumb).toBe("Project Alpha › Rollout Plan");
    expect(rollout.title).toBe("Project Alpha");
    expect(rollout.type).toBe("project");
    expect(rollout.category).toBe("wiki");
    // Breadcrumb is prepended to the indexed body so heading terms match.
    expect(rollout.body.startsWith("Project Alpha › Rollout Plan\n\n")).toBe(
      true,
    );
    expect(rollout.body).toContain("Phase one ships first.");
    // Section sourceRefs carry the frontmatter-shifted line range.
    expect(rollout.sourceRefs[0]?.range?.startLine).toBe(9);
    expect(rollout.sourceRefs[0]?.range?.endLine).toBe(11);
  });

  test("re-index of unchanged content emits an identical effect sequence", async () => {
    const files = new Map([["wiki/alpha.md", page]]);
    const first = await searchIndexText.run(
      makeContext(files, ["wiki/alpha.md"]),
    );
    const second = await searchIndexText.run(
      makeContext(files, ["wiki/alpha.md"]),
    );
    expect(second).toEqual(first);
  });

  test("deleted paths emit a single delete effect", async () => {
    const effects = asSearchEffects(
      await searchIndexText.run(makeContext(new Map(), ["wiki/gone.md"])),
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]?.operation).toBe("delete");
  });

  test("generated surface blocks stay stripped from indexed bodies", async () => {
    const daily = [
      "# 2026-06-09",
      "",
      "Hand-authored line.",
      "",
      "<!-- dome.daily:open-loops:start -->",
      "- [ ] generated open loop should not be indexed",
      "<!-- dome.daily:open-loops:end -->",
      "",
      "## Notes",
      "",
      "After the block.",
    ].join("\n");
    const files = new Map([["notes/2026-06-09.md", daily]]);
    const effects = asSearchEffects(
      await searchIndexText.run(makeContext(files, ["notes/2026-06-09.md"])),
    );
    const bodies = effects
      .filter((e) => e.operation === "upsert")
      .map((e) => (e.operation === "upsert" ? e.body : ""));
    expect(bodies.join("\n")).not.toContain("generated open loop");
    expect(bodies.join("\n")).toContain("Hand-authored line.");
    // Blanked (not removed) generated lines keep section anchors stable.
    const notes = effects.find(
      (e) => e.operation === "upsert" && e.sectionId === "notes",
    );
    if (notes?.operation !== "upsert") throw new Error("expected upsert");
    expect(notes.sourceRefs[0]?.range?.startLine).toBe(9);
  });

  test("close + brief-yesterday projection blocks are stripped; captured origins stay indexed", async () => {
    // The close block and the unified yesterday block are PROJECTION copies
    // (settles + yesterday's sections digested from elsewhere); indexing them
    // would duplicate the originals in search results. The captured block is
    // the deliberate exception — its lines are origins, real vault content.
    // Spec: [[wiki/specs/daily-surface]] §"The `captured` block holds
    // origins, not copies".
    const daily = [
      "# 2026-06-09",
      "",
      "## Captured today",
      "",
      "<!-- dome.daily:captured:start -->",
      "- [ ] #task captured origin line stays indexed",
      "<!-- dome.daily:captured:end -->",
      "",
      "## Start Here",
      "",
      "<!-- dome.agent.brief:yesterday:start -->",
      "### Yesterday",
      "- projected yesterday digest must not be indexed",
      "<!-- dome.agent.brief:yesterday:end -->",
      "",
      "## Done",
      "",
      "<!-- dome.daily:close:start -->",
      "### Done today",
      "- projected close candidate must not be indexed (from [[wiki/x]])",
      "<!-- dome.daily:close:end -->",
    ].join("\n");
    const files = new Map([["notes/2026-06-09.md", daily]]);
    const effects = asSearchEffects(
      await searchIndexText.run(makeContext(files, ["notes/2026-06-09.md"])),
    );
    const joined = effects
      .filter((e) => e.operation === "upsert")
      .map((e) => (e.operation === "upsert" ? e.body : ""))
      .join("\n");
    expect(joined).not.toContain("projected yesterday digest");
    expect(joined).not.toContain("projected close candidate");
    expect(joined).toContain("captured origin line stays indexed");
  });

  test("compiled-daily edition blocks (questions/agenda/integrated/sources) and their retired-legacy brief-namespace copies stay stripped", async () => {
    // The compiled-daily edition blocks (D6) are deterministic digests of the
    // calendar file / sweep ledger / open-questions projection — indexing
    // them would duplicate that source-of-truth content in search results.
    // Historical dailies may still carry the retired-legacy
    // dome.agent.brief:questions/integrated/sources copies, which must stay
    // stripped too.
    const daily = [
      "# 2026-06-09",
      "",
      "## Start Here",
      "",
      "<!-- dome.daily:questions:start -->",
      "### To decide",
      "- Q1 (owner-needed): projected question must not be indexed — resolve: `dome resolve 1 <answer>`",
      "<!-- dome.daily:questions:end -->",
      "",
      "<!-- dome.daily:integrated:start -->",
      "### Integrated Overnight",
      "- [[wiki/entities/alice]] ← [[wiki/dailies/2026-06-08]] projected integration must not be indexed",
      "<!-- dome.daily:integrated:end -->",
      "",
      "<!-- dome.daily:sources:start -->",
      "_Sources: calendar ✓ projected sources record must not be indexed_",
      "<!-- dome.daily:sources:end -->",
      "",
      "<!-- dome.agent.brief:questions:start -->",
      "- legacy projected question must not be indexed",
      "<!-- dome.agent.brief:questions:end -->",
      "",
      "## Meetings",
      "",
      "<!-- dome.daily:agenda:start -->",
      "- 09:30 — projected agenda meeting must not be indexed",
      "<!-- dome.daily:agenda:end -->",
      "",
      "Hand-authored prose stays indexed.",
    ].join("\n");
    const files = new Map([["notes/2026-06-09.md", daily]]);
    const effects = asSearchEffects(
      await searchIndexText.run(makeContext(files, ["notes/2026-06-09.md"])),
    );
    const joined = effects
      .filter((e) => e.operation === "upsert")
      .map((e) => (e.operation === "upsert" ? e.body : ""))
      .join("\n");
    expect(joined).not.toContain("projected question must not be indexed");
    expect(joined).not.toContain("projected integration must not be indexed");
    expect(joined).not.toContain("projected sources record must not be indexed");
    expect(joined).not.toContain("legacy projected question must not be indexed");
    expect(joined).not.toContain("projected agenda meeting must not be indexed");
    expect(joined).toContain("Hand-authored prose stays indexed.");
  });
});

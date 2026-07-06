import { describe, expect, test } from "bun:test";

import {
  claimAnchorId,
  claimsFromMarkdown,
  stampClaimAnchors,
} from "../../assets/extensions/dome.claims/processors/claims-shared";
import { parseBlockAnchor } from "../../src/core/block-anchor";

describe("claimsFromMarkdown", () => {
  test("parses a bulleted claim line with anchor, as-of date, and wikilinks", () => {
    const content = [
      "# Alice",
      "",
      "- **Level:** UNI-4 Engineering Manager — approved 2026-05 ([[wiki/sources/alice-promo-doc]]) ^c1a2b3c4d",
      "- **Pod managed:** [[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      "",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({
      line: 3,
      key: "Level",
      anchor: "c1a2b3c4d",
      asOf: null,
    });
    expect(claims[0]!.value).toContain("UNI-4 Engineering Manager");
    expect(claims[0]!.value).not.toContain("^c1a2b3c4d");
    expect(claims[1]).toMatchObject({
      line: 4,
      key: "Pod managed",
      anchor: null,
      asOf: "2026-05-22",
    });
  });

  test("parses an un-bulleted bold-key line (the existing Profile convention)", () => {
    const content = "**Tenure at Uniswap:** ~5 years (one of the longest-tenured)\n";
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ key: "Tenure at Uniswap" });
  });

  test("requires the bold key to open the line: mid-paragraph bold is not a claim", () => {
    const content = "She said **Level:** matters a lot in prose.\n";
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("ignores lines inside fenced code blocks", () => {
    const content = [
      "```md",
      "- **Level:** example inside a fence",
      "```",
    ].join("\n");
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("ignores blockquoted lines (quoted material is never a claim)", () => {
    const content = "> - **Level:** quoted from somewhere\n";
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("ignores YAML frontmatter", () => {
    const content = ["---", "type: entity", "---", "", "- **Status:** live", ""].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ line: 5, key: "Status" });
  });

  test("skips bold-key lines with an empty value or empty key", () => {
    expect(claimsFromMarkdown("- **Level:**\n")).toHaveLength(0);
    expect(claimsFromMarkdown("- **:** something\n")).toHaveLength(0);
  });

  test("does not promote discourse-marker keys (session framing, not durable facts)", () => {
    // Conversational/synthesis lines that leaked into Current facts during
    // dogfooding — framing labels, not entity attributes. None should anchor.
    const content = [
      "# Thomas T",
      "",
      "- **Net:** positive, comp is the live lever",
      "- **Tension to hold:** retain upside while managing flight risk",
      "**TL;DR:** chasing a comp bump with Allison",
      "- **Takeaway:** keep the thread warm",
      "- **My read:** he stays if the number moves",
      "- **Bottom line:** act before July",
    ].join("\n");
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("the denylist is key-scoped and case/space-insensitive, not a value scan", () => {
    // Durable claims whose VALUES happen to contain framing words still promote.
    const content = [
      "- **Comp:** net positive trajectory, $300k base *(as of 2026-06-26)*",
      "- **Status:** the bottom line is he is interviewing",
      "- **tension to hold:** lowercase + spacing variant is still excluded",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims.map((c) => c.key)).toEqual(["Comp", "Status"]);
  });

  test("bold emphasis without a trailing colon is not a claim", () => {
    expect(claimsFromMarkdown("**Important** this is just emphasis\n")).toHaveLength(0);
  });

  test("numbered narrative headers are not claim keys (enumeration, not durable facts)", () => {
    // The exact danny.md line: an unfinished narrative list item whose bold
    // prefix happens to be `**Key:**`-shaped. `1. Tone feedback delivered
    // (R4 head-on)` is a narrative enumeration header, not a Key: value
    // attribute — it must never anchor into Current facts.
    const content =
      "**1. Tone feedback delivered (R4 head-on):** told Danny he needs to outwardly own his";
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });

  test("paren-numbered narrative headers are also excluded", () => {
    expect(claimsFromMarkdown("**3) Follow-up:** scheduled\n")).toHaveLength(0);
  });

  test("a key that merely starts with digits (not `N. `/`N) `-shaped) still parses", () => {
    const content = ["**Level:** M4", "**2025 Goal:** ship v2"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims.map((c) => c.key)).toEqual(["Level", "2025 Goal"]);
  });

  test("claim lines inside a generated block are not parsed as claims", () => {
    const content = [
      "# Atlas",
      "",
      "<!-- dome.claims:current-facts:start -->",
      "- **Status:** in design review *(as of 2026-06-12)* ^cAAAA",
      "<!-- dome.claims:current-facts:end -->",
      "",
      "- **Owner:** [[danny]] ^cBBBB",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims.map((c) => c.key)).toEqual(["Owner"]);
  });

  test("a mid-line/prose mention of a start marker does NOT bound a block (line-anchored)", () => {
    // The marker text appears INLINE inside a prose sentence, not as the whole
    // line — so it is content, never a block boundary. The real claim below it
    // is parsed normally. This pins the line-anchored guarantee.
    const content = [
      "# Atlas",
      "",
      "See the generated digest <!-- dome.claims:current-facts:start --> for the current snapshot.",
      "",
      "- **Owner:** [[danny]] ^cBBBB",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims.map((c) => c.key)).toEqual(["Owner"]);
  });

  test("a hard-wrapped claim absorbs its lazy-continuation line: full joined value + endLine", () => {
    // The verified real-world truncation: a hand-authored bullet hard-wraps
    // and the line-based grammar used to cut the value at the wrap, so the
    // Current facts digest rendered the fragment ending "multi-hop test".
    const content = [
      "# Retro",
      "",
      "- **Testing:** team needs to be better at testing — there was an obvious multi-hop test",
      "  case that should have caught this (matches RCA root cause #3).",
      "",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ line: 3, endLine: 4, key: "Testing" });
    expect(claims[0]!.value).toBe(
      "team needs to be better at testing — there was an obvious multi-hop test case that should have caught this (matches RCA root cause #3).",
    );
  });

  test("a single-line claim has endLine == line", () => {
    const claims = claimsFromMarkdown("- **Level:** UNI-4\n");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ line: 1, endLine: 1 });
  });

  test("a blank line ends the claim: the paragraph after it is not absorbed", () => {
    const content = ["- **A:** one", "", "  indented paragraph after a blank"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1 });
  });

  test("a nested bullet is a new item, never a continuation", () => {
    const content = ["- **A:** one", "  - nested bullet detail"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1 });
  });

  test("an indented claim line is a new claim, never a continuation", () => {
    const content = ["- **A:** one", "  **B:** two"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims.map((c) => c.key)).toEqual(["A", "B"]);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1 });
    expect(claims[1]).toMatchObject({ line: 2, endLine: 2, value: "two" });
  });

  test("an indented heading is never a continuation", () => {
    const content = ["- **A:** one", "  ## Not part of the claim"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1 });
  });

  test("an indented blockquote is never a continuation", () => {
    const content = ["- **A:** one", "  > quoted material"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1 });
  });

  test("an anchor-only line is never a continuation", () => {
    const content = ["- **A:** one", "  ^cAAAA"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1, anchor: null });
  });

  test("an excluded line (fence inside the list item) is never a continuation", () => {
    const content = ["- **A:** one", "  ```", "  code", "  ```"].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ value: "one", endLine: 1 });
  });

  test("a trailing anchor on the LAST line is the claim's anchor, stripped from the value", () => {
    const content = [
      "- **Testing:** wraps onto a",
      "  second line here ^c1a2b3c4d",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      endLine: 2,
      anchor: "c1a2b3c4d",
      value: "wraps onto a second line here",
    });
  });

  test("a legacy anchor on the FIRST line is still recognized on a wrapped claim", () => {
    const content = [
      "- **Testing:** wraps onto a ^cAAAA",
      "  second line here",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      endLine: 2,
      anchor: "cAAAA",
      value: "wraps onto a second line here",
    });
  });

  test("when both first- and last-line anchors exist, the legacy FIRST-line anchor wins", () => {
    const content = [
      "- **Testing:** wraps onto a ^cFIRST",
      "  second line here ^cLAST",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ anchor: "cFIRST" });
  });

  test("an as-of marker on a continuation line is found (matched on the joined value)", () => {
    const content = [
      "- **Status:** shipped after the long",
      "  bake period *(as of 2026-06-01)*",
    ].join("\n");
    const claims = claimsFromMarkdown(content);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ asOf: "2026-06-01", endLine: 2 });
  });

  test("an unterminated start marker bounds no block, so the claim below it IS parsed", () => {
    const content = [
      "# Atlas",
      "",
      "<!-- dome.claims:current-facts:start -->",
      "- **Status:** in design review",
    ].join("\n");
    // The canonical generated-block primitive treats an unterminated start (no
    // matching `:end`) as no block, so a stray marker never silently drops
    // claims — the `**Status:**` line below it is parsed normally. This is
    // safer than a hand-rolled "exclude to EOF" that would swallow real claims.
    const claims = claimsFromMarkdown(content);
    expect(claims.map((c) => c.key)).toEqual(["Status"]);
  });
});

describe("stampClaimAnchors anchor dedup", () => {
  const PATH = "wiki/entities/probe.md";

  test("inserting a same-key claim above an anchored one never duplicates ids", () => {
    const first = stampClaimAnchors({ path: PATH, content: "- **Status:** one\n" })!;
    const inserted = `- **Status:** zero\n${first}`;
    const restamped = stampClaimAnchors({ path: PATH, content: inserted })!;
    const ids = restamped
      .split("\n")
      .map((l) => parseBlockAnchor(l)?.id)
      .filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // The pre-existing line keeps its original id.
    expect(ids).toContain(claimAnchorId({ path: PATH, key: "Status", occurrence: 0 }));
  });

  test("a hand-authored non-claim anchor id is never reused", () => {
    const collidingId = claimAnchorId({ path: PATH, key: "Status", occurrence: 0 });
    const content = `some prose ^${collidingId}\n- **Status:** new\n`;
    const stamped = stampClaimAnchors({ path: PATH, content })!;
    const claimLine = stamped.split("\n")[1]!;
    const id = parseBlockAnchor(claimLine)?.id;
    expect(id).toBeDefined();
    expect(id).not.toBe(collidingId);
  });
});

describe("excludedLineFlags fence-length contract (via claimsFromMarkdown)", () => {
  test("a four-backtick fence is not closed by an inner three-backtick line", () => {
    const content = [
      "````md",
      "```",
      "- **Level:** still inside the outer fence",
      "````",
    ].join("\n");
    expect(claimsFromMarkdown(content)).toHaveLength(0);
  });
});

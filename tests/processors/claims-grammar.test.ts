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

  test("bold emphasis without a trailing colon is not a claim", () => {
    expect(claimsFromMarkdown("**Important** this is just emphasis\n")).toHaveLength(0);
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

  test("an unterminated start marker excludes every claim below it to EOF", () => {
    const content = [
      "# Atlas",
      "",
      "<!-- dome.claims:current-facts:start -->",
      "- **Status:** in design review",
    ].join("\n");
    // No matching :end marker → the open block extends to EOF, so the claim
    // line below the start marker is excluded.
    expect(claimsFromMarkdown(content)).toHaveLength(0);
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

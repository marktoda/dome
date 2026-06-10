import { describe, expect, test } from "bun:test";

import { claimsFromMarkdown } from "../../assets/extensions/dome.claims/processors/claims-shared";

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
});

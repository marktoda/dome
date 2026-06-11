// tests/core/markdown-scan-characterization.test.ts
//
// Pins the EXACT line-exclusion semantics of the claims and daily markdown
// scanners — including their divergences (fence indent tolerance, blockquote
// handling). The processor-stdlib refactor must not change any of these
// observable behaviors: anchors and extraction identity in committed vaults
// depend on them.
//
// IMPORTANT: Neither `excludedLineFlags` (claims-shared) nor
// `fencedCodeBlockLineRanges`/`frontmatterLineRange` (daily-shared) are
// exported. Observable behavior is therefore pinned through the exported
// wrappers:
//   - claims: `claimsFromMarkdown` — claims only appear on non-excluded lines
//   - daily: `actionItemsFromMarkdown` — items only appear outside
//     actionExtractionLineRanges (frontmatter + fences + generated blocks)
//
// Each test embeds a sentinel claim/task on every line of interest. If the
// scanner excludes the line, no item appears in the result for that line.

import { describe, expect, test } from "bun:test";

import { claimsFromMarkdown } from "../../assets/extensions/dome.claims/processors/claims-shared";
import { actionItemsFromMarkdown } from "../../assets/extensions/dome.daily/processors/daily-shared";

// ---------------------------------------------------------------------------
// Helper: build a markdown string where each line carries a sentinel so we
// can observe which lines are excluded. Claims uses `**KEY:** value` syntax.
// ---------------------------------------------------------------------------

/** Returns the 1-based line numbers of claims extracted from `content`. */
function claimLines(content: string): number[] {
  return claimsFromMarkdown(content).map((c) => c.line);
}

/** Returns the 1-based line numbers of action items extracted from `content`. */
function actionLines(content: string): number[] {
  return actionItemsFromMarkdown(content).map((a) => a.line);
}

// ---------------------------------------------------------------------------
// Shared fixture layout (1-indexed):
//
//  1  ---                                (frontmatter open)
//  2  type: note                         (frontmatter body)
//  3  ---                                (frontmatter close)
//  4  **Body:** plain body line          (sentinel — should NOT be excluded)
//  5  ```ts                              (fence open, no indent)
//  6  **Inside:** fence content          (sentinel inside fence)
//  7  ```                                (fence close)
//  8     ```                             (fence open, 3-space indent)
//  9  **IndentFence:** indented content  (sentinel inside indented fence)
// 10     ```                             (fence close, 3-space indent)
// 11  > **Blockquote:** quoted line      (sentinel blockquote)
// 12  ~~~~                               (4-char tilde fence open)
// 13  **Tilde:** tilde content           (sentinel inside tilde fence)
// 14  ~~~~                               (tilde fence close)
// 15  **Last:** last line                (sentinel — should NOT be excluded)
// ---------------------------------------------------------------------------

const CLAIM_FIXTURE = [
  "---",
  "type: note",
  "---",
  "**Body:** plain body line",
  "```ts",
  "**Inside:** fence content",
  "```",
  "   ```",
  "**IndentFence:** indented content",
  "   ```",
  "> **Blockquote:** quoted line",
  "~~~~",
  "**Tilde:** tilde content",
  "~~~~",
  "**Last:** last line",
].join("\n");

// ---------------------------------------------------------------------------
// claims excludedLineFlags (exercised via claimsFromMarkdown)
// ---------------------------------------------------------------------------
describe("claims: excludedLineFlags via claimsFromMarkdown", () => {
  test("frontmatter block (lines 1-3) is excluded", () => {
    // Lines 1-3 are inside frontmatter — no claim for 'type' key
    const lines = claimLines(CLAIM_FIXTURE);
    expect(lines).not.toContain(1);
    expect(lines).not.toContain(2);
    expect(lines).not.toContain(3);
  });

  test("plain body line (line 4) is NOT excluded", () => {
    expect(claimLines(CLAIM_FIXTURE)).toContain(4);
  });

  test("backtick fence lines (lines 5-7) are excluded", () => {
    const lines = claimLines(CLAIM_FIXTURE);
    expect(lines).not.toContain(5);
    expect(lines).not.toContain(6);
    expect(lines).not.toContain(7);
  });

  test("3-space-indented fence lines (8-10) are excluded — claims allows 0-3 leading spaces per CommonMark", () => {
    // DIVERGENCE vs daily: claims uses /^[ ]{0,3}(`{3,}|~{3,})/ on the raw
    // line, so indented fences up to 3 spaces ARE recognized. Daily uses
    // trimStart() then /^(`{3,}|~{3,})/, which also recognizes them but via
    // a different code path.
    const lines = claimLines(CLAIM_FIXTURE);
    expect(lines).not.toContain(8);
    expect(lines).not.toContain(9);
    expect(lines).not.toContain(10);
  });

  test("blockquote line (line 11) is skipped by claimsFromMarkdown (not by excludedLineFlags)", () => {
    // excludedLineFlags does NOT set the blockquote flag; instead,
    // claimsFromMarkdown itself does: `if (raw.trimStart().startsWith(">")) continue`
    // Either way the claim is not returned.
    const lines = claimLines(CLAIM_FIXTURE);
    expect(lines).not.toContain(11);
  });

  test("4-char tilde fence lines (12-14) are excluded", () => {
    const lines = claimLines(CLAIM_FIXTURE);
    expect(lines).not.toContain(12);
    expect(lines).not.toContain(13);
    expect(lines).not.toContain(14);
  });

  test("last line (15) is NOT excluded", () => {
    expect(claimLines(CLAIM_FIXTURE)).toContain(15);
  });

  test("unterminated fence excludes to EOF", () => {
    // An unterminated fence — no sentinel below it should appear.
    const content = [
      "**Before:** before fence",
      "```",
      "**Inside:** inside unterminated fence",
    ].join("\n");
    const lines = claimLines(content);
    expect(lines).toEqual([1]); // only "Before" on line 1
  });
});

// ---------------------------------------------------------------------------
// daily: frontmatterLineRange / fencedCodeBlockLineRanges via
// actionItemsFromMarkdown (indirectly: uses actionExtractionLineRanges which
// calls both scanner functions)
//
// Fixture uses open-checkbox lines (`- [ ] sentinel`) as sentinels — they
// appear in actionItemsFromMarkdown only if NOT in an ignored range.
//
// Layout (1-indexed):
//  1  ---                      frontmatter open
//  2  title: daily             frontmatter body
//  3  ---                      frontmatter close
//  4  - [ ] body task          sentinel — should appear
//  5  ```                      backtick fence open
//  6  - [ ] inside fence       sentinel inside fence
//  7  ```                      fence close
//  8     ```                   3-space indented fence open
//  9  - [ ] indented fence     sentinel inside indented fence
// 10     ```                   indented fence close
// 11  > - [ ] blockquote task  blockquote — daily skips this at extraction
// 12  ~~~~                     tilde fence open
// 13  - [ ] tilde content      sentinel inside tilde fence
// 14  ~~~~                     tilde fence close
// 15  - [ ] last task          sentinel — should appear
// ---------------------------------------------------------------------------

const DAILY_FIXTURE = [
  "---",
  "title: daily",
  "---",
  "- [ ] body task",
  "```",
  "- [ ] inside fence",
  "```",
  "   ```",
  "- [ ] indented fence task",
  "   ```",
  "> - [ ] blockquote task",
  "~~~~",
  "- [ ] tilde content",
  "~~~~",
  "- [ ] last task",
].join("\n");

describe("daily: actionExtractionLineRanges via actionItemsFromMarkdown", () => {
  test("frontmatter range (lines 1-3) excludes tasks", () => {
    // frontmatterLineRange returns {start:1, end:3} (1-indexed, inclusive).
    // Tasks on frontmatter lines do not appear.
    const lines = actionLines(DAILY_FIXTURE);
    expect(lines).not.toContain(1);
    expect(lines).not.toContain(2);
    expect(lines).not.toContain(3);
  });

  test("body task (line 4) is NOT excluded — appears in result", () => {
    expect(actionLines(DAILY_FIXTURE)).toContain(4);
  });

  test("backtick fence lines (5-7) are excluded", () => {
    const lines = actionLines(DAILY_FIXTURE);
    expect(lines).not.toContain(5);
    expect(lines).not.toContain(6);
    expect(lines).not.toContain(7);
  });

  test("3-space-indented fence (8-10): daily DOES recognize via trimStart() — DIVERGENCE from regex path", () => {
    // daily uses: /^(`{3,}|~{3,})/.exec(line.trimStart())
    // trimStart() removes the 3 leading spaces, then the regex matches.
    // Both claims and daily recognize indented fences, but via different code
    // paths. The observable result is the SAME: tasks inside are excluded.
    //
    // FROZEN DIVERGENCE: claims uses /^[ ]{0,3}(`{3,}|~{3,})/ on raw line;
    // daily uses trimStart() + /^(`{3,}|~{3,})/. Both tolerate indented fences
    // (0-3 spaces for claims; any leading whitespace for daily via trimStart).
    // Claims is stricter: 4-space indent would NOT be recognized (CommonMark
    // spec says 4 spaces = code block). Daily would still recognize it via
    // trimStart. This difference is preserved; do not unify.
    const lines = actionLines(DAILY_FIXTURE);
    expect(lines).not.toContain(8);
    expect(lines).not.toContain(9);
    expect(lines).not.toContain(10);
  });

  test("blockquote line (11) is skipped at extraction (not fence exclusion)", () => {
    // actionItemsFromMarkdown checks `line.trimStart().startsWith(">")` after
    // the range check. The blockquote task is therefore not extracted.
    const lines = actionLines(DAILY_FIXTURE);
    expect(lines).not.toContain(11);
  });

  test("tilde fence lines (12-14) are excluded", () => {
    const lines = actionLines(DAILY_FIXTURE);
    expect(lines).not.toContain(12);
    expect(lines).not.toContain(13);
    expect(lines).not.toContain(14);
  });

  test("last task (line 15) is NOT excluded — appears in result", () => {
    expect(actionLines(DAILY_FIXTURE)).toContain(15);
  });

  test("unterminated fence: task inside extends to EOF (no close line)", () => {
    // An unterminated fence should exclude all lines after the open.
    const content = [
      "- [ ] before",
      "```",
      "- [ ] inside unterminated",
    ].join("\n");
    const lines = actionLines(content);
    expect(lines).toEqual([1]); // only line 1 is outside the unterminated fence
  });

  test("frontmatterLineRange is 1-indexed inclusive", () => {
    // Verify via a document where line 1 = `---`, line 3 = `---` (close).
    // Only tasks outside [1,3] appear. Line 4 task should appear.
    const content = "---\nfoo: bar\n---\n- [ ] after frontmatter";
    const lines = actionLines(content);
    expect(lines).toEqual([4]);
  });

  test("fence ranges are 1-indexed inclusive of open and close lines", () => {
    // A two-line fence: open on line 2, close on line 3.
    // Tasks on lines 2, 3 (the fence delimiters) should be excluded.
    const content = [
      "- [ ] before fence",
      "```",
      "```",
      "- [ ] after fence",
    ].join("\n");
    const lines = actionLines(content);
    // Lines 2 and 3 are the fence — excluded. Lines 1 and 4 are outside.
    expect(lines).toContain(1);
    expect(lines).not.toContain(2);
    expect(lines).not.toContain(3);
    expect(lines).toContain(4);
  });
});

// ---------------------------------------------------------------------------
// Fence tighter char-mismatch behavior: daily's fencedCodeBlockLineRanges
// does NOT deduplicate by fence length — a ``` closer closes the nearest
// open ``` regardless of length. Verify this doesn't cause false negatives.
// ---------------------------------------------------------------------------
describe("daily fence: same-char close match (tighter: same char only)", () => {
  test("tilde fence is not closed by backtick line", () => {
    // Open: ~~~~ (4 tildes). Inner: - [ ] sentinel. Close attempt: ``` (backtick).
    // The backtick line should NOT close the tilde fence.
    const content = [
      "~~~~",
      "- [ ] inside tilde",
      "```",
      "still inside",
      "~~~~",
      "- [ ] outside",
    ].join("\n");
    const lines = actionLines(content);
    // Line 2 is inside the tilde fence, line 6 is outside (after ~~~~ close on line 5)
    expect(lines).not.toContain(2);
    expect(lines).toContain(6);
  });
});

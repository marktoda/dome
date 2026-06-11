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
import { actionItemsFromMarkdown } from "../../assets/extensions/dome.daily/processors/action-extraction";

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
//  2  **Key:** frontmatter value         (sentinel INSIDE frontmatter)
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
  "**Key:** frontmatter value", // line 2: real sentinel INSIDE frontmatter
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
  test("frontmatter block (lines 1-3) is excluded — real sentinel on line 2", () => {
    // Line 2 is a real claim-syntax line (**Key:** frontmatter value) placed
    // INSIDE the frontmatter block. It must NOT be extracted, proving the
    // frontmatter exclusion is active (not vacuous).
    const lines = claimLines(CLAIM_FIXTURE);
    expect(lines).not.toContain(1);
    expect(lines).not.toContain(2); // sentinel claim inside frontmatter — excluded
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

  // FROZEN DIVERGENCE: 4-space indent
  test("4-space-indented fence (claims): NOT recognized — claim inside IS extracted", () => {
    // claims uses /^[ ]{0,3}(`{3,}|~{3,})/ on the raw line. 4 leading spaces
    // exceed the 0-3 limit, so the fence is not recognized by claims. The
    // sentinel claim line inside is therefore visible.
    //
    // DIVERGENCE vs daily: daily uses trimStart() which removes ALL leading
    // spaces, so a 4-space-indented fence IS recognized by daily (task excluded).
    // This asymmetry is the headline divergence. Do not unify.
    const content = [
      "    ```",                   // line 1: 4-space-indented fence open
      "**Key:** value",            // line 2: sentinel claim — visible to claims
      "    ```",                   // line 3: 4-space-indented fence close
      "**After:** done",           // line 4: sentinel after
    ].join("\n");
    const lines = claimLines(content);
    // claims does NOT recognize the 4-space fence → both lines 2 and 4 visible
    expect(lines).toContain(2); // inside the "fence" — but claims sees no fence
    expect(lines).toContain(4); // after the "fence"
  });

  // FROZEN DIVERGENCE: fence-close length requirement
  test("fence-close length (claims): 3-backtick line does NOT close a 4-backtick opener", () => {
    // claims requires closer run-length >= opener run-length. A ```` opener
    // (minLen=4) is NOT closed by a ``` (length=3). The content after the
    // 3-tick line remains inside the fence. A 4-tick line is required to close.
    //
    // DIVERGENCE vs daily: daily only checks same char (char === fenceChar),
    // ignoring run length. So daily DOES close a 4-tick opener with a 3-tick
    // line, making content after the 3-tick line visible.
    const content = [
      "````",                           // line 1: 4-backtick opener
      "**Inside:** inside fence",        // line 2: sentinel inside
      "```",                            // line 3: 3-backtick — does NOT close (claims)
      "**After3tick:** after 3-tick",   // line 4: still inside fence (claims)
      "````",                           // line 5: 4-backtick — true close (claims)
      "**TrueAfter:** true after",       // line 6: outside fence
    ].join("\n");
    const lines = claimLines(content);
    // Empirically verified: claims returns only line 6
    expect(lines).not.toContain(2); // inside fence
    expect(lines).not.toContain(3); // fence line excluded
    expect(lines).not.toContain(4); // still inside fence (3-tick didn't close)
    expect(lines).not.toContain(5); // 4-tick close line excluded
    expect(lines).toContain(6);     // outside — first visible sentinel
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
//  1  ---                              frontmatter open
//  2  - [ ] task inside frontmatter    sentinel INSIDE frontmatter
//  3  ---                              frontmatter close
//  4  - [ ] body task                  sentinel — should appear
//  5  ```                              backtick fence open
//  6  - [ ] inside fence               sentinel inside fence
//  7  ```                              fence close
//  8     ```                           3-space indented fence open
//  9  - [ ] indented fence             sentinel inside indented fence
// 10     ```                           indented fence close
// 11  > - [ ] blockquote task          blockquote — daily skips this at extraction
// 12  ~~~~                             tilde fence open
// 13  - [ ] tilde content              sentinel inside tilde fence
// 14  ~~~~                             tilde fence close
// 15  - [ ] last task                  sentinel — should appear
// ---------------------------------------------------------------------------

const DAILY_FIXTURE = [
  "---",
  "- [ ] task inside frontmatter", // line 2: real sentinel INSIDE frontmatter
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
  test("frontmatter range (lines 1-3) excludes tasks — real sentinel on line 2", () => {
    // Line 2 is a real open-checkbox line (`- [ ] task inside frontmatter`)
    // placed INSIDE the frontmatter block. It must NOT be extracted, proving
    // the exclusion is active (not vacuous). frontmatterLineRange returns
    // {start:1, end:3} (1-indexed, inclusive).
    const lines = actionLines(DAILY_FIXTURE);
    expect(lines).not.toContain(1);
    expect(lines).not.toContain(2); // sentinel task inside frontmatter — excluded
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
    // `> - [ ] blockquote task` is rejected because isOpenCheckboxLine's
    // regex `/^\s*[-*]\s+\[ \]\s+\S/` does not match a line starting with
    // `>` — the `>` is not `\s*[-*]`. There is no explicit startsWith(">")
    // guard in actionItemsFromMarkdown; it is the regex failure that silently
    // drops it (daily-shared.ts:1525-1527).
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

  // FROZEN DIVERGENCE: 4-space indent
  test("4-space-indented fence (daily): IS recognized via trimStart — task inside excluded", () => {
    // daily uses trimStart() before matching /^(`{3,}|~{3,})/. This removes
    // all leading spaces, so a 4-space-indented fence IS recognized.
    //
    // DIVERGENCE vs claims: claims uses /^[ ]{0,3}(`{3,}|~{3,})/ on raw line,
    // so 4 leading spaces exceed the 0-3 limit and the fence is NOT recognized.
    // This means claims extracts the claim inside while daily excludes the task.
    // This asymmetry is the headline divergence. Do not unify.
    const content = [
      "    ```",                               // line 1: 4-space-indented fence open
      "- [ ] task inside indented fence",      // line 2: sentinel — excluded by daily
      "    ```",                               // line 3: 4-space-indented fence close
      "- [ ] outside task",                   // line 4: sentinel — should appear
    ].join("\n");
    const lines = actionLines(content);
    // daily DOES recognize the 4-space fence → line 2 excluded, line 4 visible
    expect(lines).not.toContain(2); // inside fence — excluded
    expect(lines).toContain(4);     // after fence close — visible
  });

  // FROZEN DIVERGENCE: fence-close length requirement
  test("fence-close length (daily): 3-backtick line DOES close a 4-backtick opener", () => {
    // daily only checks same char (char === fenceChar) — it does NOT require
    // closer run-length >= opener run-length. A ```` opener IS closed by ```.
    // The content after the 3-tick close line is therefore visible.
    //
    // DIVERGENCE vs claims: claims requires closer length >= opener length, so
    // a 4-tick opener is only closed by another 4-tick (or longer) line. The
    // content at line 4 remains inside the fence in claims, but is outside in daily.
    const content = [
      "````",                           // line 1: 4-backtick opener
      "- [ ] inside fence",             // line 2: sentinel inside
      "```",                            // line 3: 3-backtick — DOES close (daily)
      "- [ ] after 3-tick",             // line 4: outside fence (daily)
      "````",                           // line 5: would be "true close" per claims
      "- [ ] true after",               // line 6: sentinel after line 5
    ].join("\n");
    const lines = actionLines(content);
    // Empirically verified: daily returns [4] — line 4 is outside (fence closed at line 3)
    expect(lines).not.toContain(2); // inside fence
    expect(lines).toContain(4);     // after 3-tick close — visible (daily closes here)
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

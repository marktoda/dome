// `dome lint` — usage-error tests and rendering unit tests.
// Shared setup lives in ./fixture.ts.

import { describe, expect, test } from "bun:test";

import {
  parseLintData,
  renderLintText,
  runLint,
  type LintData,
} from "../../../src/cli/commands/lint";

import {
  captured,
  installConsoleCapture,
} from "./fixture";

installConsoleCapture();

// ----- runLint --------------------------------------------------------------

describe("runLint", () => {
  test("malformed --limit returns 64 before opening runtime", async () => {
    expect(await runLint({ limit: "nope" })).toBe(64);
    expect(captured.err.join("\n")).toContain(
      "--limit must be a positive integer",
    );
  });

  test("--json usage errors emit structured JSON", async () => {
    expect(await runLint({ limit: "nope", json: true })).toBe(64);
    const payload = JSON.parse(captured.out.join("\n")) as {
      readonly status: string;
      readonly error: string;
      readonly message: string;
    };
    expect(payload).toMatchObject({
      status: "error",
      error: "lint-usage",
      message: "dome lint: --limit must be a positive integer.",
    });
    expect(captured.err).toEqual([]);
  });
});

// ----- renderLintText (unit) ------------------------------------------------

// Minimal LintData with no issues (all counts zero).
const CLEAN_DATA: LintData = parseLintData({
  status: "pass",
  failOn: "error",
  checked: { markdownFiles: 42 },
  counts: { total: 0, block: 0, error: 0, warning: 0, info: 0 },
  shownIssues: 0,
  omittedIssues: 0,
  issues: [],
});

// LintData with one warning and one info issue.
const DIRTY_DATA: LintData = parseLintData({
  status: "fail",
  failOn: "warning",
  checked: { markdownFiles: 10 },
  counts: { total: 2, block: 0, error: 0, warning: 1, info: 1 },
  shownIssues: 2,
  omittedIssues: 0,
  issues: [
    {
      severity: "info",
      code: "dome.markdown.broken-wikilink",
      message: "Wikilink [[foo]] does not resolve.",
      sourceRefs: [{ path: "wiki/notes.md", commit: "abc1234" }],
    },
    {
      severity: "warning",
      code: "dome.markdown.orphan",
      message: "Page has no inbound links.",
      sourceRefs: [{ path: "wiki/orphan.md", commit: "def5678" }],
    },
  ],
});

describe("renderLintText (no-color caps)", () => {
  test("breakdown contains every severity term even when all zero", () => {
    const out = renderLintText(CLEAN_DATA, "/vault/path");
    expect(out).toContain("0 total");
    expect(out).toContain("0 block");
    expect(out).toContain("0 error");
    expect(out).toContain("0 warning");
    expect(out).toContain("0 info");
  });

  test("empty Issues section shows 'none'", () => {
    const out = renderLintText(CLEAN_DATA, "/vault/path");
    expect(out).toContain("none");
  });

  test("breakdown contains non-zero counts when issues exist", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path");
    expect(out).toContain("2 total");
    expect(out).toContain("1 warning");
    expect(out).toContain("1 info");
    expect(out).toContain("0 block");
    expect(out).toContain("0 error");
  });

  test("issues render in finding anatomy: code header and what line", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path");
    // finding primitive emits the code on the header line
    expect(out).toContain("dome.markdown.orphan");
    expect(out).toContain("dome.markdown.broken-wikilink");
    // what lines — the messages
    expect(out).toContain("Page has no inbound links.");
    expect(out).toContain("Wikilink [[foo]] does not resolve.");
    // subject — the file path from sourceRefs[0]
    expect(out).toContain("wiki/orphan.md");
    expect(out).toContain("wiki/notes.md");
  });

  test("issues are sorted by severity (warning before info)", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path");
    const warningIdx = out.indexOf("dome.markdown.orphan");
    const infoIdx = out.indexOf("dome.markdown.broken-wikilink");
    expect(warningIdx).toBeLessThan(infoIdx);
  });

  test("old run-on format ([warning] code: message) is not present", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path");
    expect(out).not.toMatch(/\[warning\]/);
    expect(out).not.toMatch(/\[info\]/);
  });
});

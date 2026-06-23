// `dome lint` — usage-error tests and rendering unit tests.
// Shared setup lives in ./fixture.ts.

import { describe, expect, test } from "bun:test";

import {
  renderLintText,
  runLint,
} from "../../../src/cli/commands/lint";
import {
  lintPayloadSchema,
  type LintData,
} from "../../../src/surface/lint-view";

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
const CLEAN_DATA: LintData = lintPayloadSchema.parse({
  status: "pass",
  failOn: "error",
  checked: { markdownFiles: 42 },
  counts: { total: 0, block: 0, error: 0, warning: 0, info: 0 },
  shownIssues: 0,
  omittedIssues: 0,
  issues: [],
});

// LintData that passes (failOn=error) but still has warning/info issues.
const PASS_WITH_ISSUES_DATA: LintData = lintPayloadSchema.parse({
  status: "pass",
  failOn: "error",
  checked: { markdownFiles: 7 },
  counts: { total: 2, block: 0, error: 0, warning: 1, info: 1 },
  shownIssues: 2,
  omittedIssues: 0,
  issues: [
    {
      severity: "info",
      code: "dome.markdown.broken-wikilink",
      message: "Wikilink [[bar]] does not resolve.",
      sourceRefs: [{ path: "wiki/notes.md", commit: "aaa1111" }],
    },
    {
      severity: "warning",
      code: "dome.markdown.orphan",
      message: "Page has no inbound links.",
      sourceRefs: [{ path: "wiki/orphan.md", commit: "bbb2222" }],
    },
  ],
});

// LintData with one warning and one info issue.
const DIRTY_DATA: LintData = lintPayloadSchema.parse({
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
  // ── default (non-verbose) ──────────────────────────────────────────────────

  test("pass is a single non-blank line (verdict only)", () => {
    const out = renderLintText(CLEAN_DATA, "/vault/path");
    const nonBlank = out.split("\n").filter((l) => l.trim().length > 0);
    expect(nonBlank.length).toBe(1);
    expect(out).toMatch(/pass — \d+ files, no issues/);
    expect(out).not.toContain("CHECKED");
    expect(out).not.toContain("ISSUES");
    expect(out).not.toMatch(/[-─]{10,}/);
  });

  test("pass with sub-threshold issues: header says 'below threshold', not 'no issues'", () => {
    const out = renderLintText(PASS_WITH_ISSUES_DATA, "/vault/path");
    expect(out).toContain("below threshold");
    expect(out).not.toContain("no issues");
    expect(out).toMatch(/pass — 7 files, 2 issues below threshold/);
  });

  test("pass with sub-threshold issues: individual issues still render in body", () => {
    const out = renderLintText(PASS_WITH_ISSUES_DATA, "/vault/path");
    expect(out).toContain("dome.markdown.orphan");
    expect(out).toContain("dome.markdown.broken-wikilink");
    expect(out).toContain("Page has no inbound links.");
    expect(out).toContain("Wikilink [[bar]] does not resolve.");
  });

  test("issues default: no ISSUES/CHECKED section headers, no footer rule", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path");
    expect(out).not.toMatch(/^\s+ISSUES\s*$/m);
    expect(out).not.toMatch(/^\s+CHECKED\s*$/m);
    expect(out).not.toMatch(/[-─]{10,}/);
  });

  test("issues default: findings rendered directly (codes + messages present)", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path");
    expect(out).toContain("dome.markdown.orphan");
    expect(out).toContain("dome.markdown.broken-wikilink");
    expect(out).toContain("Page has no inbound links.");
    expect(out).toContain("Wikilink [[foo]] does not resolve.");
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

  // ── verbose ────────────────────────────────────────────────────────────────

  test("verbose pass: CHECKED section with breakdown present", () => {
    const out = renderLintText(CLEAN_DATA, "/vault/path", true);
    expect(out).toContain("CHECKED");
    expect(out).toContain("0 total");
    expect(out).toContain("0 block");
    expect(out).toContain("0 error");
    expect(out).toContain("0 warning");
    expect(out).toContain("0 info");
  });

  test("verbose pass: no footer rule", () => {
    const out = renderLintText(CLEAN_DATA, "/vault/path", true);
    expect(out).not.toMatch(/[-─]{10,}/);
  });

  test("verbose issues: CHECKED section present with breakdown", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path", true);
    expect(out).toContain("CHECKED");
    expect(out).toContain("2 total");
    expect(out).toContain("1 warning");
    expect(out).toContain("1 info");
    expect(out).toContain("0 block");
    expect(out).toContain("0 error");
  });

  test("verbose issues: findings still rendered (codes + messages)", () => {
    const out = renderLintText(DIRTY_DATA, "/vault/path", true);
    expect(out).toContain("dome.markdown.orphan");
    expect(out).toContain("dome.markdown.broken-wikilink");
    expect(out).toContain("Page has no inbound links.");
    expect(out).toContain("Wikilink [[foo]] does not resolve.");
  });
});

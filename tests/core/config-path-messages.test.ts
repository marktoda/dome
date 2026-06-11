// tests/core/config-path-messages.test.ts
//
// Pins the exact problem/error strings of the three config path validators.
// These strings surface in user-facing diagnostics; the stdlib extraction
// must reproduce them byte-for-byte.
//
// IMPORTANT: The plan predicted bare problem strings like
//   "core_path must be a string"
// but the actual implementations WRAP the bare message:
//   "dome.agent config ${bare}; falling back to ${DEFAULT}"
// Both coreMemoryPath and consolidationLedgerPath use this pattern.
// The actual .problem values are frozen here as observed — not as predicted.

import { describe, expect, test } from "bun:test";

import { coreMemoryPath } from "../../assets/extensions/dome.agent/lib/core-memory";
import { consolidationLedgerPath } from "../../assets/extensions/dome.agent/processors/consolidate";
import { dailyPathSettings } from "../../assets/extensions/dome.daily/processors/daily-paths";

// ---------------------------------------------------------------------------
// coreMemoryPath
// Default path: "core.md"
// fallback(msg) => resolution(DEFAULT, `dome.agent config ${msg}; falling back to core.md`)
// ---------------------------------------------------------------------------
describe("coreMemoryPath problems", () => {
  test("non-string config value", () => {
    // bare: "core_path must be a string"
    // wrapped: "dome.agent config core_path must be a string; falling back to core.md"
    expect(coreMemoryPath({ core_path: 42 }).problem).toBe(
      "dome.agent config core_path must be a string; falling back to core.md",
    );
  });

  test("non-.md path", () => {
    // bare: "core_path must be a non-empty .md path"
    // wrapped: "dome.agent config core_path must be a non-empty .md path; falling back to core.md"
    expect(coreMemoryPath({ core_path: "notes/core.txt" }).problem).toBe(
      "dome.agent config core_path must be a non-empty .md path; falling back to core.md",
    );
  });

  test("absolute path", () => {
    // bare: "core_path must be a relative vault markdown path"
    // wrapped with DEFAULT fallback
    expect(coreMemoryPath({ core_path: "/abs/core.md" }).problem).toBe(
      "dome.agent config core_path must be a relative vault markdown path; falling back to core.md",
    );
  });

  test(".. traversal", () => {
    expect(coreMemoryPath({ core_path: "a/../core.md" }).problem).toBe(
      "dome.agent config core_path must be a relative vault markdown path; falling back to core.md",
    );
  });

  test("undefined config → default path, no problem", () => {
    const result = coreMemoryPath(undefined);
    expect(result.problem).toBeNull();
    expect(result.path).toBe("core.md");
  });

  test("valid path → no problem, resolved path returned", () => {
    const result = coreMemoryPath({ core_path: "notes/core.md" });
    expect(result.problem).toBeNull();
    expect(result.path).toBe("notes/core.md");
  });
});

// ---------------------------------------------------------------------------
// consolidationLedgerPath
// Default path: "consolidation-ledger.md"
// fallback(msg) => resolution(DEFAULT, `dome.agent config ${msg}; falling back to consolidation-ledger.md`)
// ---------------------------------------------------------------------------
describe("consolidationLedgerPath problems", () => {
  test("non-string config value", () => {
    expect(consolidationLedgerPath({ consolidation_ledger_path: 42 }).problem).toBe(
      "dome.agent config consolidation_ledger_path must be a string; falling back to consolidation-ledger.md",
    );
  });

  test("absolute path", () => {
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "/x.md" }).problem,
    ).toBe(
      "dome.agent config consolidation_ledger_path must be a relative vault markdown path; falling back to consolidation-ledger.md",
    );
  });

  test("non-.md path", () => {
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "ledger.txt" }).problem,
    ).toBe(
      "dome.agent config consolidation_ledger_path must be a non-empty .md path; falling back to consolidation-ledger.md",
    );
  });

  test(".. traversal", () => {
    expect(
      consolidationLedgerPath({ consolidation_ledger_path: "a/../ledger.md" }).problem,
    ).toBe(
      "dome.agent config consolidation_ledger_path must be a relative vault markdown path; falling back to consolidation-ledger.md",
    );
  });

  test("undefined config → default path, no problem", () => {
    const result = consolidationLedgerPath(undefined);
    expect(result.problem).toBeNull();
    expect(result.path).toBe("consolidation-ledger.md");
  });

  test("valid path → no problem, resolved path returned", () => {
    const result = consolidationLedgerPath({ consolidation_ledger_path: "ledger/consolidation.md" });
    expect(result.problem).toBeNull();
    expect(result.path).toBe("ledger/consolidation.md");
  });
});

// ---------------------------------------------------------------------------
// dailyPathSettings / validateDailyPathTemplate
// Throws (does NOT return a problem): throws Error with exact string.
//
// Note: dailyPathSettings checks typeof first (throws), then delegates to
// validateDailyPathTemplate for string values.
// validateDailyPathTemplate check order:
//   1. {date} count (must be exactly one)
//   2. trim/empty check
//   3. .md check (sample must end with .md)
//   4. absolute/traversal check
// ---------------------------------------------------------------------------
describe("dailyPathSettings throws with exact messages", () => {
  test("non-string throws", () => {
    expect(() => dailyPathSettings({ daily_path: 42 })).toThrow(
      "dome.daily config daily_path must be a string",
    );
  });

  test("missing {date} placeholder throws", () => {
    expect(() => dailyPathSettings({ daily_path: "notes/x.md" })).toThrow(
      "dome.daily config daily_path must contain exactly one {date} placeholder",
    );
  });

  test("multiple {date} placeholders throws", () => {
    expect(() =>
      dailyPathSettings({ daily_path: "{date}/notes/{date}.md" }),
    ).toThrow(
      "dome.daily config daily_path must contain exactly one {date} placeholder",
    );
  });

  test("template that produces non-.md file throws", () => {
    // sample = "{date}/notes/{date}".replace("{date}", "2026-01-02") → has .md check
    // "notes/{date}.txt" → sample "notes/2026-01-02.txt" does not end with .md
    // DIVERGENCE from coreMemoryPath: daily's message is "must produce a .md file"
    // NOT "must be a non-empty .md path". This different wording is preserved.
    expect(() => dailyPathSettings({ daily_path: "notes/{date}.txt" })).toThrow(
      "dome.daily config daily_path must produce a .md file",
    );
  });

  test("absolute path throws", () => {
    expect(() => dailyPathSettings({ daily_path: "/abs/{date}.md" })).toThrow(
      "dome.daily config daily_path must be a relative vault markdown path",
    );
  });

  test(".. traversal throws", () => {
    expect(() => dailyPathSettings({ daily_path: "a/../{date}.md" })).toThrow(
      "dome.daily config daily_path must be a relative vault markdown path",
    );
  });

  test("undefined config → default, no throw", () => {
    // DEFAULT_DAILY_PATH_SETTINGS is returned when config is undefined.
    const result = dailyPathSettings(undefined);
    expect(result).toBeDefined();
  });

  test("valid template → returns DailyPathSettings with template", () => {
    const result = dailyPathSettings({ daily_path: "notes/{date}.md" });
    expect(result.template).toBe("notes/{date}.md");
  });

  test("valid nested path template → no throw", () => {
    const result = dailyPathSettings({ daily_path: "wiki/dailies/{date}.md" });
    expect(result.template).toBe("wiki/dailies/{date}.md");
  });
});

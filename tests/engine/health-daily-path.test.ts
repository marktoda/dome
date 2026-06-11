// The daily_path mirroring check (`config.daily-path-mismatch`).
//
// dome.agent.brief resolves the daily note from dome.agent's `daily_path`
// while dome.daily.create-daily reads dome.daily's — a vault overriding only
// one gets a wrong-path morning brief plus a duplicate skeleton at 06:00.
// `dome doctor` compares the two raw config values whenever BOTH bundles are
// enabled and raises a warning finding when they diverge. Both-unset means
// both bundles sit on the shared default and is fine; the engine never needs
// to know what that default is.

import { describe, expect, test } from "bun:test";

import { dailyPathMismatchFindings } from "../../src/engine/host/health";

function findingsFor(opts: {
  readonly enabled: ReadonlyArray<string>;
  readonly configs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}) {
  return dailyPathMismatchFindings({
    extensions: opts.enabled.map((name) => ({ name })),
    extensionConfigFor: (extensionId) => opts.configs[extensionId] ?? {},
  });
}

const BOTH = ["dome.daily", "dome.agent"];

describe("dailyPathMismatchFindings", () => {
  test("no finding when both bundles leave daily_path unset (shared default)", () => {
    expect(findingsFor({ enabled: BOTH, configs: {} })).toEqual([]);
  });

  test("no finding when both bundles set the same daily_path", () => {
    expect(
      findingsFor({
        enabled: BOTH,
        configs: {
          "dome.daily": { daily_path: "notes/{date}.md" },
          "dome.agent": { daily_path: "notes/{date}.md" },
        },
      }),
    ).toEqual([]);
  });

  test("warning finding when only dome.daily overrides daily_path (the mirroring footgun)", () => {
    const findings = findingsFor({
      enabled: BOTH,
      configs: { "dome.daily": { daily_path: "notes/{date}.md" } },
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("config.daily-path-mismatch");
    expect(finding.severity).toBe("warning");
    expect(finding.subject).toBe("config");
    expect(finding.id).toBe("daily_path");
    expect(finding.message).toContain('dome.daily: "notes/{date}.md"');
    expect(finding.message).toContain("dome.agent: (unset — bundle default)");
    expect(finding.recovery).toContain("shared_config.daily_path");
    if (finding.code === "config.daily-path-mismatch") {
      expect(finding.config).toEqual({
        dailyDailyPath: "notes/{date}.md",
        agentDailyPath: null,
      });
    }
  });

  test("warning finding when only dome.agent overrides daily_path", () => {
    const findings = findingsFor({
      enabled: BOTH,
      configs: { "dome.agent": { daily_path: "notes/{date}.md" } },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("config.daily-path-mismatch");
  });

  test("warning finding when both override but with different templates", () => {
    const findings = findingsFor({
      enabled: BOTH,
      configs: {
        "dome.daily": { daily_path: "notes/{date}.md" },
        "dome.agent": { daily_path: "wiki/dailies/{date}.md" },
      },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.code).toBe("config.daily-path-mismatch");
  });

  test("no finding unless BOTH bundles are enabled", () => {
    const configs = { "dome.daily": { daily_path: "notes/{date}.md" } };
    expect(
      findingsFor({ enabled: ["dome.daily"], configs }),
    ).toEqual([]);
    expect(
      findingsFor({ enabled: ["dome.agent"], configs }),
    ).toEqual([]);
    expect(findingsFor({ enabled: [], configs })).toEqual([]);
  });

  test("a non-string daily_path value is treated as unset (config validation lives in the bundle)", () => {
    expect(
      findingsFor({
        enabled: BOTH,
        configs: {
          "dome.daily": { daily_path: 7 },
          "dome.agent": {},
        },
      }),
    ).toEqual([]);
  });
});

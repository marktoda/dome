// The model-fetcher timeout footgun (`config.sources-timeout-default`).
//
// A dome.sources subscription whose fetch command runs a headless model
// (the shipped claude-calendar template) rides out the 30s dispatch default
// and dies; discovering that from failed outbox rows is miserable. Doctor
// raises an INFO finding up front whenever any subscription is enabled
// while `engine.external_handler_timeout_ms` is unset — the simplest honest
// trigger per wiki/specs/sources.md §"Timeout" (no command-string sniffing:
// wrappers hide model runners and names false-positive). Info severity by
// design: a direct API fetcher under the default is healthy, so the report
// stays "ok".

import { describe, expect, test } from "bun:test";

import { sourcesHandlerTimeoutFindings } from "../../src/engine/host/health";

function findingsFor(opts: {
  readonly enabled: ReadonlyArray<string>;
  readonly sourcesConfig: Readonly<Record<string, unknown>>;
  readonly timeoutConfigured: boolean;
}) {
  return sourcesHandlerTimeoutFindings({
    extensions: opts.enabled.map((name) => ({ name })),
    extensionConfigFor: (extensionId) =>
      extensionId === "dome.sources" ? opts.sourcesConfig : {},
    externalHandlerTimeoutConfigured: opts.timeoutConfigured,
  });
}

const CALENDAR_ENABLED = {
  subscriptions: {
    calendar: {
      enabled: true,
      schedule: "10 5 * * *",
      output_path: "sources/calendar/{date}.md",
      command: ["sh", ".dome/bin/fetch-calendar.sh"],
    },
  },
};

describe("sourcesHandlerTimeoutFindings", () => {
  test("info finding when a subscription is enabled and the timeout is unset", () => {
    const findings = findingsFor({
      enabled: ["dome.sources"],
      sourcesConfig: CALENDAR_ENABLED,
      timeoutConfigured: false,
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("config.sources-timeout-default");
    expect(finding.severity).toBe("info");
    expect(finding.subject).toBe("config");
    expect(finding.id).toBe("sources_timeout");
    expect(finding.message).toContain("calendar");
    expect(finding.message).toContain("external_handler_timeout_ms");
    expect(finding.recovery).toContain("300000");
    if (finding.code === "config.sources-timeout-default") {
      expect(finding.config).toEqual({ enabledKinds: ["calendar"] });
    }
  });

  test("no finding once external_handler_timeout_ms is set", () => {
    expect(
      findingsFor({
        enabled: ["dome.sources"],
        sourcesConfig: CALENDAR_ENABLED,
        timeoutConfigured: true,
      }),
    ).toEqual([]);
  });

  test("no finding when no subscription is enabled (disabled, absent, or junk-enabled)", () => {
    for (const sourcesConfig of [
      {},
      { subscriptions: {} },
      { subscriptions: { calendar: { enabled: false } } },
      { subscriptions: { calendar: { enabled: "yes" } } },
      { subscriptions: "nope" },
    ]) {
      expect(
        findingsFor({
          enabled: ["dome.sources"],
          sourcesConfig,
          timeoutConfigured: false,
        }),
      ).toEqual([]);
    }
  });

  test("no finding when the dome.sources bundle itself is not active", () => {
    expect(
      findingsFor({
        enabled: ["dome.daily"],
        sourcesConfig: CALENDAR_ENABLED,
        timeoutConfigured: false,
      }),
    ).toEqual([]);
  });

  test("multiple enabled kinds are listed sorted", () => {
    const findings = findingsFor({
      enabled: ["dome.sources"],
      sourcesConfig: {
        subscriptions: {
          slack: { enabled: true },
          calendar: { enabled: true },
        },
      },
      timeoutConfigured: false,
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    if (finding.code === "config.sources-timeout-default") {
      expect(finding.config.enabledKinds).toEqual(["calendar", "slack"]);
    }
  });
});

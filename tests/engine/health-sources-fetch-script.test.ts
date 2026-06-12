// The missing-fetch-script probe (`sources.fetch-script-missing`).
//
// An `enabled: true` dome.sources subscription whose command references a
// script file that is missing (or not a regular file) fails on every
// scheduled fetch; discovering that from failed outbox rows the next morning
// is miserable. Doctor flags it up front: kind + script path + the
// `dome init --with-source <kind>` recovery. The check is STATIC — doctor
// never executes the fetch command (it would hit Slack/calendar for real).
// Disabled or absent subscriptions produce nothing; a present script file is
// healthy (no finding). Commands with no statically checkable script
// reference (bare PATH lookups, `sh -c` inline scripts) are skipped — a
// false positive on a working stub would be worse than silence.

import { describe, expect, test } from "bun:test";

import { sourcesFetchScriptFindings } from "../../src/engine/host/health";

function findingsFor(opts: {
  readonly enabled: ReadonlyArray<string>;
  readonly sourcesConfig: Readonly<Record<string, unknown>>;
  readonly files?: ReadonlyArray<string>;
}) {
  return sourcesFetchScriptFindings({
    extensions: opts.enabled.map((name) => ({ name })),
    extensionConfigFor: (extensionId) =>
      extensionId === "dome.sources" ? opts.sourcesConfig : {},
    scriptIsFile: (path) => (opts.files ?? []).includes(path),
  });
}

function subscription(opts: {
  readonly kind: string;
  readonly enabled: boolean;
  readonly command: ReadonlyArray<string> | unknown;
}): Readonly<Record<string, unknown>> {
  return {
    subscriptions: {
      [opts.kind]: {
        enabled: opts.enabled,
        schedule: "15 5 * * *",
        output_path: `sources/${opts.kind}/{date}.md`,
        command: opts.command,
      },
    },
  };
}

describe("sourcesFetchScriptFindings", () => {
  test("enabled subscription with a missing script → finding (kind + path + --with-source recovery)", () => {
    const findings = findingsFor({
      enabled: ["dome.sources"],
      sourcesConfig: subscription({
        kind: "slack",
        enabled: true,
        command: ["sh", ".dome/bin/fetch-slack.sh"],
      }),
      files: [],
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    expect(finding.code).toBe("sources.fetch-script-missing");
    expect(finding.severity).toBe("warning");
    expect(finding.subject).toBe("config");
    expect(finding.id).toBe("sources_fetch:slack");
    expect(finding.message).toContain("slack");
    expect(finding.message).toContain(".dome/bin/fetch-slack.sh");
    expect(finding.recovery).toContain("dome init --with-source slack");
    if (finding.code === "sources.fetch-script-missing") {
      expect(finding.sources).toEqual({
        kind: "slack",
        scriptPath: ".dome/bin/fetch-slack.sh",
      });
    }
  });

  test("present script file → no finding (healthy)", () => {
    expect(
      findingsFor({
        enabled: ["dome.sources"],
        sourcesConfig: subscription({
          kind: "calendar",
          enabled: true,
          command: ["sh", ".dome/bin/fetch-calendar.sh"],
        }),
        files: [".dome/bin/fetch-calendar.sh"],
      }),
    ).toEqual([]);
  });

  test("disabled, absent, or junk subscriptions → nothing", () => {
    for (const sourcesConfig of [
      {},
      { subscriptions: {} },
      subscription({
        kind: "slack",
        enabled: false,
        command: ["sh", ".dome/bin/fetch-slack.sh"],
      }),
      { subscriptions: { slack: { enabled: "yes" } } },
      { subscriptions: "nope" },
    ]) {
      expect(
        findingsFor({ enabled: ["dome.sources"], sourcesConfig, files: [] }),
      ).toEqual([]);
    }
  });

  test("dome.sources bundle not active → nothing", () => {
    expect(
      findingsFor({
        enabled: ["dome.daily"],
        sourcesConfig: subscription({
          kind: "slack",
          enabled: true,
          command: ["sh", ".dome/bin/fetch-slack.sh"],
        }),
        files: [],
      }),
    ).toEqual([]);
  });

  test("a direct script path in command[0] is checked", () => {
    const findings = findingsFor({
      enabled: ["dome.sources"],
      sourcesConfig: subscription({
        kind: "calendar",
        enabled: true,
        command: [".dome/bin/fetch-calendar.sh"],
      }),
      files: [],
    });
    expect(findings.length).toBe(1);
    const finding = findings[0]!;
    if (finding.code === "sources.fetch-script-missing") {
      expect(finding.sources.scriptPath).toBe(".dome/bin/fetch-calendar.sh");
    }
  });

  test("commands with no statically checkable script reference are skipped", () => {
    for (const command of [
      // `sh -c` inline stub — the Task-6 e2e shape; flagging the inline
      // script text as a missing file would be a false positive.
      ["sh", "-c", "echo done > sources/slack/x.md"],
      // Bare PATH lookup: existence is a PATH question, not a vault one.
      ["my-fetcher"],
      // Junk shapes: a probe never throws.
      [],
      "not-a-list",
      ["sh", 42],
      undefined,
    ]) {
      expect(
        findingsFor({
          enabled: ["dome.sources"],
          sourcesConfig: subscription({
            kind: "slack",
            enabled: true,
            command,
          }),
          files: [],
        }),
      ).toEqual([]);
    }
  });

  test("multiple enabled kinds with missing scripts → one finding each, sorted by kind", () => {
    const findings = findingsFor({
      enabled: ["dome.sources"],
      sourcesConfig: {
        subscriptions: {
          slack: {
            enabled: true,
            command: ["sh", ".dome/bin/fetch-slack.sh"],
          },
          calendar: {
            enabled: true,
            command: ["sh", ".dome/bin/fetch-calendar.sh"],
          },
        },
      },
      files: [],
    });
    expect(findings.map((finding) => finding.id)).toEqual([
      "sources_fetch:calendar",
      "sources_fetch:slack",
    ]);
  });
});

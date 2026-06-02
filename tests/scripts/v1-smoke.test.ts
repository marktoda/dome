import { describe, expect, test } from "bun:test";

import { formatVaultSmokeSummary } from "../../scripts/v1-smoke";

describe("v1 smoke script", () => {
  test("summary distinguishes current adopted state from catch-up work", () => {
    const line = formatVaultSmokeSummary({
      label: "work",
      status: statusPayload({
        head: "abcdef1234567890",
        adopted: "abcdef1234567890",
        sync_needed: false,
      }),
      viewSchemas: ["dome.search.query/v1", "dome.search.export-context/v1"],
      catchupSyncRan: false,
      settledSync: "checked",
      notices: [],
    });

    expect(line).toContain("adopted current yes");
    expect(line).toContain("catch-up sync not needed");
    expect(line).not.toContain("synced no");
  });

  test("summary reports catch-up sync separately when it ran", () => {
    const line = formatVaultSmokeSummary({
      label: "docs",
      status: statusPayload({
        head: "fedcba1234567890",
        adopted: "fedcba1234567890",
        sync_needed: false,
      }),
      viewSchemas: ["dome.search.query/v1"],
      catchupSyncRan: true,
      settledSync: "checked",
      notices: ["1 informational diagnostic(s)"],
    });

    expect(line).toContain("adopted current yes");
    expect(line).toContain("catch-up sync ran");
    expect(line).toContain("notices 1 informational diagnostic(s)");
  });

  test("summary reports non-current adopted state directly", () => {
    const line = formatVaultSmokeSummary({
      label: "work",
      status: statusPayload({
        head: "abcdef1234567890",
        adopted: "1111111234567890",
        sync_needed: true,
      }),
      viewSchemas: ["dome.search.query/v1"],
      catchupSyncRan: false,
      settledSync: "skipped",
      notices: ["1 pending commit(s)"],
    });

    expect(line).toContain("adopted current no");
    expect(line).toContain("catch-up sync not run");
    expect(line).toContain("settled skipped");
    expect(line).toContain("notices 1 pending commit(s)");
  });
});

function statusPayload(
  overrides: Partial<Parameters<typeof formatVaultSmokeSummary>[0]["status"]>,
): Parameters<typeof formatVaultSmokeSummary>[0]["status"] {
  return {
    vault: "/tmp/vault",
    branch: "main",
    head: null,
    adopted: null,
    sync_needed: false,
    pending_commits: 0,
    adopted_diverged: false,
    dirty_modified: 0,
    dirty_untracked: 0,
    diagnostics: 0,
    attention_diagnostics: 0,
    questions: 0,
    pending_runs: 0,
    failed_runs: 0,
    outbox_failed: 0,
    quarantined: 0,
    ...overrides,
  };
}

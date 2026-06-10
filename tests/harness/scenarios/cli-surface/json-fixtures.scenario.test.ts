// scenarios/cli-surface/json-fixtures.scenario.test.ts
//
// Stable JSON shapes are part of the agent-facing CLI contract. This scenario
// exercises the four Milestone 9 fixture surfaces through the real harness:
// status, doctor, query, and export-context.

import { expect } from "bun:test";

import { scenario } from "../../index";

const STATUS_KEYS = Object.freeze([
  "vault",
  "branch",
  "head",
  "adopted",
  "sync_needed",
  "pending_commits",
  "adopted_diverged",
  "projection_stale",
  "projection_cache_drift",
  "attention_required",
  "attention",
  "next_actions",
  "dirty_modified",
  "dirty_untracked",
  "dirty_modified_paths",
  "dirty_untracked_paths",
  "content_pages",
  "wiki_pages",
  "notes_pages",
  "inbox_pages",
  "inbox_raw_pages",
  "wikilinks",
  "raw_files",
  "raw_bytes",
  "last_sync",
  "pending_runs",
  "orphan_runs",
  "failed_runs",
  "recent_processor_runs",
  "maintenance_loops",
  "serve_status",
  "serve_pid",
  "serve_branch",
  "serve_updated_at",
  "service_status",
  "service_label",
  "model_provider_configured",
  "model_provider_probe_status",
  "model_provider_probed_at",
  "diagnostics",
  "content_diagnostics",
  "unlocated_diagnostics",
  "attention_diagnostics",
  "diagnostic_summary",
  "attention_diagnostic_summary",
  "diagnostic_message_summary",
  "attention_diagnostic_message_summary",
  "diagnostic_disposition_summary",
  "attention_diagnostic_disposition_summary",
  "questions",
  "outbox_pending",
  "outbox_failed",
  "quarantined",
]);

const DOCTOR_KEYS = Object.freeze([
  "status",
  "generatedAt",
  "summary",
  "findings",
]);

const DOCTOR_SUMMARY_KEYS = Object.freeze([
  "findingCount",
  "errorCount",
  "warningCount",
  "failedOutbox",
  "stuckPendingOutbox",
  "orphanRuns",
  "failedRuns",
  "quarantinedProcessors",
  "projectionCacheDrift",
  "adoptedRefDivergence",
  "instructionDrift",
  "operationalSchemaMismatch",
  "capabilityGrantGaps",
  "capabilityGrantEntryGaps",
  "modelProviderMissing",
  "modelProviderUnreachable",
  "modelProviderKeyMissing",
  "dailyPathMismatch",
]);

const QUERY_KEYS = Object.freeze([
  "schema",
  "query",
  "filters",
  "limit",
  "shown",
  "hasMore",
  "matches",
]);
const QUERY_MATCH_KEYS = Object.freeze([
  "path",
  "title",
  "category",
  "type",
  "sectionId",
  "breadcrumb",
  "snippet",
  "rank",
  "ranking",
  "sourceRefs",
  "facts",
  "diagnostics",
  "questions",
]);

const EXPORT_KEYS = Object.freeze([
  "schema",
  "topic",
  "limit",
  "shown",
  "hasMore",
  "overview",
  "markdown",
  "entries",
]);
const EXPORT_ENTRY_KEYS = Object.freeze([
  "path",
  "title",
  "category",
  "type",
  "sectionId",
  "breadcrumb",
  "snippet",
  "rank",
  "ranking",
  "sourceRefs",
  "summary",
  "facts",
  "diagnostics",
  "questions",
]);

scenario(
  {
    name: "cli-surface: status doctor query export JSON fixtures stay stable",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "search-document" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "adoption" },
      { kind: "phase", phase: "view" },
      { kind: "capability", capability: "search.write" },
      { kind: "trigger", trigger: "signal" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: { bundles: ["dome.markdown", "dome.graph", "dome.search"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "wiki/project-alpha.md":
          "---\n" +
          "type: concept\n" +
          "tags:\n" +
          "  - strategy\n" +
          "---\n" +
          "# Project Alpha\n\n" +
          "Alpha launch planning assigns rollout ownership to the platform team.\n",
      },
      message: "add alpha planning note",
    });
    const sync = await h.tick();
    expect(sync.adopted).toBe(true);

    const status = parseJson(await h.runCli(["status", "--json"]));
    expect(Object.keys(status)).toEqual([...STATUS_KEYS]);
    expect(status["branch"]).toBe("main");
    expect(status["sync_needed"]).toBe(false);
    expect(status["pending_commits"]).toBe(0);
    expect(status["adopted_diverged"]).toBe(false);
    expect(status["projection_stale"]).toBe(false);
    expect(status["projection_cache_drift"]).toBe(false);
    expect(status["attention_required"]).toBe(true);
    expect(status["attention"]).toEqual(["dirty_untracked"]);
    const dirtyUntrackedPaths = status["dirty_untracked_paths"] as
      ReadonlyArray<string>;
    expect(dirtyUntrackedPaths.length).toBeGreaterThan(0);
    expect(status["next_actions"]).toEqual([
      {
        reasons: ["dirty_untracked"],
        command: "git status --short",
        description: expect.stringContaining(
          `untracked: ${dirtyUntrackedPaths[0]}`,
        ),
      },
    ]);
    expect(status["dirty_untracked"]).toBeGreaterThan(0);
    expect(status["content_pages"]).toBe(1);
    expect(Array.isArray(status["recent_processor_runs"])).toBe(true);
    expect(Array.isArray(status["maintenance_loops"])).toBe(true);
    expect(status["serve_status"]).toBe("off");
    // The launchd service line: a never-installed tmp vault is informational
    // only ("unsupported" off macOS); no service attention reason.
    expect(["not-installed", "unsupported"]).toContain(
      String(status["service_status"]),
    );
    expect(status["attention"]).not.toContain("service_not_loaded");
    // No model provider configured -> no probe state, no attention.
    expect(status["model_provider_configured"]).toBe(false);
    expect(status["model_provider_probe_status"]).toBeNull();
    expect(status["model_provider_probed_at"]).toBeNull();

    const doctor = parseJson(await h.runCli(["doctor", "--json"]));
    expect(Object.keys(doctor)).toEqual([...DOCTOR_KEYS]);
    expect(doctor["status"]).toBe("ok");
    expect(Object.keys(record(doctor["summary"]))).toEqual([
      ...DOCTOR_SUMMARY_KEYS,
    ]);
    expect(record(doctor["summary"])["findingCount"]).toBe(0);
    expect(doctor["findings"]).toEqual([]);

    const query = parseJson(await h.runCli(["query", "alpha launch", "--json"]));
    expect(Object.keys(query)).toEqual([...QUERY_KEYS]);
    expect(query["schema"]).toBe("dome.search.query/v1");
    expect(query["query"]).toBe("alpha launch");
    expect(query["limit"]).toBe(10);
    expect(record(query["shown"])["matches"]).toBe(1);
    expect(record(query["hasMore"])["matches"]).toBe(false);
    const queryMatch = firstRecord(query["matches"]);
    expect(Object.keys(queryMatch)).toEqual([...QUERY_MATCH_KEYS]);
    expect(queryMatch["path"]).toBe("wiki/project-alpha.md");
    expect(Object.keys(record(queryMatch["ranking"]))).toEqual([
      "score",
      "ftsRank",
      "recencyFactor",
      "reasons",
      "signals",
    ]);
    expect(Array.isArray(queryMatch["sourceRefs"])).toBe(true);
    expect(Array.isArray(queryMatch["facts"])).toBe(true);

    const exported = parseJson(
      await h.runCli(["export-context", "alpha launch", "--json", "--limit", "2"]),
    );
    expect(Object.keys(exported)).toEqual([...EXPORT_KEYS]);
    expect(exported["schema"]).toBe("dome.search.export-context/v1");
    expect(exported["topic"]).toBe("alpha launch");
    expect(exported["limit"]).toBe(2);
    expect(record(exported["shown"])["entries"]).toBe(1);
    expect(record(exported["hasMore"])["entries"]).toBe(false);
    expect(String(exported["markdown"])).toContain(
      "# Dome Context: alpha launch",
    );
    const exportEntry = firstRecord(exported["entries"]);
    expect(Object.keys(exportEntry)).toEqual([...EXPORT_ENTRY_KEYS]);
    expect(exportEntry["path"]).toBe("wiki/project-alpha.md");
    expect(Object.keys(record(exportEntry["ranking"]))).toEqual([
      "score",
      "ftsRank",
      "recencyFactor",
      "reasons",
      "signals",
    ]);
    expect(Array.isArray(exportEntry["sourceRefs"])).toBe(true);
    expect(Array.isArray(exportEntry["facts"])).toBe(true);
    expect(Array.isArray(exportEntry["diagnostics"])).toBe(true);
    expect(Array.isArray(exportEntry["questions"])).toBe(true);
  },
);

function parseJson(result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): Record<string, unknown> {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === "object" && !Array.isArray(value))
    .toBe(true);
  return value as Record<string, unknown>;
}

function firstRecord(value: unknown): Record<string, unknown> {
  expect(Array.isArray(value)).toBe(true);
  const first = (value as ReadonlyArray<unknown>)[0];
  return record(first);
}

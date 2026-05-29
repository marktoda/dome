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
  "dirty_modified",
  "dirty_untracked",
  "content_pages",
  "wiki_pages",
  "notes_pages",
  "inbox_pages",
  "wikilinks",
  "raw_files",
  "raw_bytes",
  "last_sync",
  "pending_runs",
  "failed_runs",
  "recent_processor_runs",
  "serve_status",
  "serve_pid",
  "serve_branch",
  "serve_updated_at",
  "diagnostics",
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
  "quarantinedProcessors",
  "projectionCacheDrift",
  "adoptedRefDivergence",
  "instructionDrift",
  "operationalSchemaMismatch",
  "capabilityGrantGaps",
]);

const QUERY_KEYS = Object.freeze(["schema", "query", "filters", "matches"]);
const QUERY_MATCH_KEYS = Object.freeze([
  "path",
  "title",
  "category",
  "type",
  "snippet",
  "rank",
  "sourceRefs",
  "facts",
]);

const EXPORT_KEYS = Object.freeze([
  "schema",
  "topic",
  "limit",
  "markdown",
  "entries",
]);
const EXPORT_ENTRY_KEYS = Object.freeze([
  "path",
  "title",
  "category",
  "type",
  "snippet",
  "rank",
  "sourceRefs",
  "facts",
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
          "type: project\n" +
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
    expect(status["content_pages"]).toBe(1);
    expect(Array.isArray(status["recent_processor_runs"])).toBe(true);
    expect(status["serve_status"]).toBe("off");

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
    const queryMatch = firstRecord(query["matches"]);
    expect(Object.keys(queryMatch)).toEqual([...QUERY_MATCH_KEYS]);
    expect(queryMatch["path"]).toBe("wiki/project-alpha.md");
    expect(Array.isArray(queryMatch["sourceRefs"])).toBe(true);
    expect(Array.isArray(queryMatch["facts"])).toBe(true);

    const exported = parseJson(
      await h.runCli(["export-context", "alpha launch", "--json", "--limit", "2"]),
    );
    expect(Object.keys(exported)).toEqual([...EXPORT_KEYS]);
    expect(exported["schema"]).toBe("dome.search.export-context/v1");
    expect(exported["topic"]).toBe("alpha launch");
    expect(exported["limit"]).toBe(2);
    expect(String(exported["markdown"])).toContain(
      "# Dome Context: alpha launch",
    );
    const exportEntry = firstRecord(exported["entries"]);
    expect(Object.keys(exportEntry)).toEqual([...EXPORT_ENTRY_KEYS]);
    expect(exportEntry["path"]).toBe("wiki/project-alpha.md");
    expect(Array.isArray(exportEntry["sourceRefs"])).toBe(true);
    expect(Array.isArray(exportEntry["facts"])).toBe(true);
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

import { expect } from "bun:test";

import type { Harness } from "../../index";

export const SCENARIO_TIMEOUT_MS = 240_000;
export const HOST_OFF_PROCESSOR_RUNS = 151;
export const HOST_ON_PROCESSOR_RUNS = 172;

// These journeys deliberately exercise fixed-point cascades: their ledgers
// prove 151 and 172 sequential processor runs respectively. Each journey has
// its own test file, so its root runner process owns one 240s scenario inside
// the 300s file supervisor. Bound the tiny deterministic fixture at the child
// seam: 172 * 1s = 172s, leaving at least 68s for setup, Git, SQLite, CLI
// dispatch, and scenario cleanup, then a further 60s for process-group cleanup.
//
// The previous 500ms cap could expire under whole-suite CPU pressure and then
// recover on a later invocation: `status.failed_runs` intentionally reports
// only the latest run per processor, so that history could look healthy while
// the exact ledger count drifted. The terminal-history assertion below makes
// any recurrence report the actual non-success status instead.
const PROCESSOR_TIMEOUT_MS = 1_000;

export function expectProcessorRuns(h: Harness, expected: number): void {
  const rows = h.ledger.raw
    .query(
      "SELECT status, COUNT(*) AS count FROM runs GROUP BY status ORDER BY status",
    )
    .all() as ReadonlyArray<{
      readonly status: string;
      readonly count: number;
    }>;
  expect(rows).toEqual([{ status: "succeeded", count: expected }]);
}

export function v1DeterministicConfig(): string {
  return `
engine:
  processor_timeout_ms: ${PROCESSOR_TIMEOUT_MS}
extensions:
  dome.markdown:
    enabled: true
    grant:
      read:
        - "**/*.md"
        - ".dome/page-types.yaml"
        - "**/*.{png,jpg,jpeg,gif,webp,svg,avif}"
      patch.auto: ["**/*.md"]
      question.ask: true
  dome.graph:
    enabled: true
    grant:
      read: ["**/*.md"]
      graph.write: ["dome.graph.*"]
  dome.search:
    enabled: true
    grant:
      read: ["**/*.md"]
      search.write: ["**/*.md"]
  dome.daily:
    enabled: true
    grant:
      read:
        - "wiki/**/*.md"
        - "wiki/dailies/*.md"
      patch.auto: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
      questions.read: true
      proposals.read: true
  dome.health:
    enabled: true
    grant:
      read: ["**"]
      outbox.read: ["failed"]
      outbox.recover: ["retry", "abandon"]
      quarantine.read: true
      quarantine.recover: ["reset"]
      run.read: ["running"]
      run.recover: ["fail"]
      question.ask: true
      proposals.read: true
      patch.propose: [".dome/config.yaml"]
`;
}

export function dailyWithOpenTask(date: string): string {
  return [
    "---",
    "type: daily",
    `recurrence: ${date}`,
    "---",
    "",
    `# ${date}`,
    "",
    "## Notes",
    "",
    "- [ ] Review launch staffing plan",
    "",
  ].join("\n");
}

export function projectPageTypes(): string {
  return [
    "extensions:",
    "  - name: project",
    "    frontmatter_extras:",
    "      title: required",
    "",
  ].join("\n");
}

export function projectPage(input: {
  readonly title: string;
  readonly body: ReadonlyArray<string>;
}): string {
  return [
    "---",
    "type: project",
    `title: ${input.title}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    ...input.body,
    "",
  ].join("\n");
}

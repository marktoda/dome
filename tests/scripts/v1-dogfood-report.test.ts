import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const REPORT_SCRIPT = join(REPO_ROOT, "scripts", "v1-dogfood-report.ts");

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe("v1 dogfood report script", () => {
  test("help describes the M10 rubric audit", async () => {
    const result = await runReport(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Audits the M10 work-vault dogfood ledger against the V1 release-soak rubric.",
    );
  });

  test("counts complete workdays and capture-evidence days", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from \`dome today\` and picked the next task.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: A meeting follow-up appeared without manual search.
- Context packet quality: \`export-context\` gave the foreground agent the right read-first files.
- Question burden: No owner-needed questions appeared.
- Link/concept hygiene: Remaining diagnostics were known backlog.
- Friction / manual foreground-agent work Dome should own: Still had to ask for one duplicate review.

## 2026-06-02 Work Session

Operational state:
- \`bin/dome today --vault ~/vaults/work --json\`

Qualitative notes to fill after the work session:
- Daily note usefulness: Useful start surface.
- Capture digestion:
- Open-loop surfacing: Some surfaced loops were helpful.
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("ready");
    expect(report.completeWorkdays).toBe(1);
    expect(report.captureEvidenceDays).toBe(1);
    expect(report.days).toHaveLength(2);
    expect(report.days[0].complete).toBe(true);
    expect(report.days[1].complete).toBe(false);
    expect(report.days[1].missingDimensions).toContain("capture_digestion");
    expect(report.days[1].missingDimensions).toContain("context_packet_quality");
  });

  test("keeps the default M10 thresholds not-ready for partial ledgers", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Dogfood Snapshot

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: No captures today.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
`);

    const result = await runReport(["--ledger", ledger]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Status: not-ready");
    expect(result.stdout).toContain("Complete workdays: 1/10");
    expect(result.stdout).toContain("Capture-evidence days: 0/5");
  });

  test("does not count qualitative notes without measured Dome surface evidence", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.captureEvidenceDays).toBe(1);
    expect(report.days[0].complete).toBe(false);
    expect(report.days[0].operationalEvidence).toBe(false);
    expect(report.days[0].missingDimensions).toEqual([]);
  });
});

function writeLedger(markdown: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-v1-dogfood-report-"));
  fixtures.push(dir);
  const path = join(dir, "ledger.md");
  writeFileSync(path, markdown.trimStart());
  return path;
}

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runReport(args: ReadonlyArray<string>): Promise<ProcessResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, REPORT_SCRIPT, ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

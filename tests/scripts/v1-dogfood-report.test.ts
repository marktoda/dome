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

  test("counts complete workdays and complete capture-evidence days", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`
- Serve host: running; branch main; pid 123

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from \`dome today\` and picked the next task.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: A meeting follow-up appeared without manual search.
- Context packet quality: \`export-context\` gave the foreground agent the right read-first files.
- Question burden: No owner-needed questions appeared.
- Link/concept hygiene: Remaining diagnostics were known backlog.
- Friction / manual foreground-agent work Dome should own: Still had to ask for one duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no

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
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("ready");
    expect(report.completeWorkdays).toBe(1);
    expect(report.serveHostEvidenceDays).toBe(1);
    expect(report.captureEvidenceDays).toBe(1);
    expect(report.spanCalendarDays).toBe(1);
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
- Serve host: running; branch main; pid 123

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: No captures today.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport(["--ledger", ledger]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Status: not-ready");
    expect(result.stdout).toContain("Complete workdays: 1/10");
    expect(result.stdout).toContain("Serve-host evidence days: 1/10");
    expect(result.stdout).toContain("Complete capture-evidence days: 0/5");
    expect(result.stdout).toContain("Complete-workday span: 1/12");
  });

  test("requires running serve-host evidence for counted workdays", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`
- Serve host: off

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.serveHostEvidenceDays).toBe(0);
    expect(report.days[0].operationalEvidence).toBe(true);
    expect(report.days[0].serveHostEvidence).toBe(false);
    expect(report.days[0].captureEvidence).toBe(true);
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
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.captureEvidenceDays).toBe(0);
    expect(report.days[0].complete).toBe(false);
    expect(report.days[0].captureEvidence).toBe(true);
    expect(report.days[0].operationalEvidence).toBe(false);
    expect(report.days[0].missingDimensions).toEqual([]);
    expect(report.days[0].missingSafetyConfirmations).toEqual([]);
  });

  test("does not count a bare operational heading as measured Dome evidence", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.days[0].complete).toBe(false);
    expect(report.days[0].operationalEvidence).toBe(false);
  });

  test("does not count negated Dome command references as operational evidence", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- Did not run \`bin/dome status --vault ~/vaults/work --json\` today.
- Serve host: running; branch main; pid 123

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.days[0].operationalEvidence).toBe(false);
    expect(report.days[0].serveHostEvidence).toBe(true);
  });

  test("does not count contradictory serve-host wording as host evidence", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`
- Serve host: running; but it was stale and on the wrong branch

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.serveHostEvidenceDays).toBe(0);
    expect(report.days[0].operationalEvidence).toBe(true);
    expect(report.days[0].serveHostEvidence).toBe(false);
  });

  test("counts backticked verified serve status as host evidence", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- Verified \`bin/dome status --vault ~/vaults/work --json\` reported \`serve_status: running\`, \`serve_pid: 123\`, and \`serve_branch: main\`.

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("ready");
    expect(report.completeWorkdays).toBe(1);
    expect(report.days[0].serveHostEvidence).toBe(true);
  });

  test("does not let partial capture-only days satisfy the capture threshold", async () => {
    const ledger = writeLedger(`
# Test ledger

${completeDay("2026-06-01", "No captures today.")}

## 2026-06-02 Capture Note

Qualitative notes to fill after the work session:
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/2026-06-02.md\`.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(1);
    expect(report.captureEvidenceDays).toBe(0);
    expect(report.days[1].complete).toBe(false);
    expect(report.days[1].captureEvidence).toBe(true);
  });

  test("does not treat negative capture wording as capture evidence", async () => {
    const ledger = writeLedger(`
# Test ledger

${completeDay("2026-06-01", "No raw captures processed today.")}
${completeDay("2026-06-02", "Did not generate an intake page; no captures arrived.")}
${completeDay("2026-06-03", "Processed one raw capture into \`wiki/generated/intake/example.md\`.")}
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "3",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.completeWorkdays).toBe(3);
    expect(report.captureEvidenceDays).toBe(1);
    expect(
      report.days.map((day: { captureEvidence: boolean }) =>
        day.captureEvidence
      ),
    ).toEqual([false, false, true]);
  });

  test("requires complete workdays to span the release-soak window", async () => {
    const ledger = writeLedger([
      completeDay("2026-06-01"),
      completeDay("2026-06-02"),
      completeDay("2026-06-03"),
      completeDay("2026-06-04"),
      completeDay("2026-06-05"),
    ].join("\n\n"));

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "5",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "12",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(5);
    expect(report.captureEvidenceDays).toBe(5);
    expect(report.spanCalendarDays).toBe(5);
    expect(report.required.spanCalendarDays).toBe(12);
  });

  test("treats observed safety problems as release blockers", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`
- Serve host: running; branch main; pid 123

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: yes, one generated patch overwrote a draft
- Manual .dome/state edits: no
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.serveHostEvidenceDays).toBe(1);
    expect(report.releaseBlockers).toEqual([{
      date: "2026-06-01",
      blockers: ["lost_or_overwritten_edits"],
    }]);
    expect(report.days[0].releaseBlockers).toEqual([
      "lost_or_overwritten_edits",
    ]);
  });

  test("treats contradictory negative safety confirmations as release blockers", async () => {
    const ledger = writeLedger(`
# Test ledger

## 2026-06-01 Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`
- Serve host: running; branch main; pid 123

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/example.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no, but one generated patch overwrote a draft
- Manual .dome/state edits: none except I manually edited \`.dome/state/runs.db\`
`);

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.completeWorkdays).toBe(0);
    expect(report.releaseBlockers).toEqual([{
      date: "2026-06-01",
      blockers: ["lost_or_overwritten_edits", "manual_dome_state_edits"],
    }]);
    expect(report.days[0].safetyConfirmed).toBe(false);
  });

  test("require-ready exits nonzero for an incomplete release soak", async () => {
    const ledger = writeLedger(completeDay("2026-06-01"));

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "2",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--require-ready",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Status: not-ready");
  });

  test("require-ready exits zero when thresholds are satisfied", async () => {
    const ledger = writeLedger(completeDay("2026-06-01"));

    const result = await runReport([
      "--ledger",
      ledger,
      "--min-days",
      "1",
      "--min-capture-days",
      "1",
      "--min-span-days",
      "1",
      "--require-ready",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Status: ready");
  });
});

function writeLedger(markdown: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-v1-dogfood-report-"));
  fixtures.push(dir);
  const path = join(dir, "ledger.md");
  writeFileSync(path, markdown.trimStart());
  return path;
}

function completeDay(
  date: string,
  captureNote = `Processed one raw capture into \`wiki/generated/intake/${date}.md\`.`,
): string {
  return `
## ${date} Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`
- Serve host: running; branch main; pid 123

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: ${captureNote}
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: Still needed manual duplicate review.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`.trim();
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

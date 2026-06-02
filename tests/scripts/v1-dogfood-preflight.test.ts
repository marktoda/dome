import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DOME_BIN = join(REPO_ROOT, "bin", "dome");
const PREFLIGHT_SCRIPT = join(REPO_ROOT, "scripts", "v1-dogfood-preflight.ts");

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe("v1 dogfood preflight script", () => {
  test("help describes the read-only M10 session check", async () => {
    const result = await runPreflight(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Checks whether a vault is ready to collect the next M10 dogfood session.",
    );
  });

  test("reports disabled intake as not ready while preserving release status", async () => {
    const vaultPath = await makeInitializedVault();
    const ledgerPath = writeLedger(completeDay("2026-06-01"));

    const result = await runPreflight([
      "--vault",
      vaultPath,
      "--ledger",
      ledgerPath,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("not-ready");
    expect(report.operational.ready).toBe(true);
    expect(report.serve.ready).toBe(false);
    expect(report.serve.status).toBe("off");
    expect(report.serve.findings).toContain(
      "dome serve is off; start it during real work sessions for M10 host evidence",
    );
    expect(report.capture.ready).toBe(false);
    expect(report.capture.intakeStatus).toBe("disabled");
    expect(report.capture.modelStatus).toBe("disabled-provider-configured");
    expect(report.capture.findings).toContain("dome.intake is disabled");
    expect(report.release.status).toBe("not-ready");
    expect(report.nextActions).toContain(
      "enable dome.intake with a configured model provider before capture dogfood",
    );
    expect(report.nextActions).toContain(
      "start dome serve while dogfooding to collect host evidence",
    );
  }, { timeout: 30_000 });

  test("renders a Markdown preflight with commands and next actions", async () => {
    const vaultPath = await makeInitializedVault();
    const ledgerPath = writeLedger(completeDay("2026-06-01"));

    const result = await runPreflight([
      "--vault",
      vaultPath,
      "--ledger",
      ledgerPath,
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# V1 M10 Dogfood Preflight");
    expect(result.stdout).toContain("Collection status: not-ready");
    expect(result.stdout).toContain("Operational readiness:");
    expect(result.stdout).toContain("Serve-host evidence:");
    expect(result.stdout).toContain("- Status: off");
    expect(result.stdout).toContain("Capture readiness:");
    expect(result.stdout).toContain("Release-soak report:");
    expect(result.stdout).toContain("Next actions:");
    expect(result.stdout).toContain("Commands run:");
  }, { timeout: 30_000 });
});

async function makeInitializedVault(): Promise<string> {
  const vaultPath = mkdtempSync(join(tmpdir(), "dome-v1-dogfood-preflight-"));
  fixtures.push(vaultPath);
  const init = await runDome(["init", vaultPath, "--with-model-provider", "anthropic"]);
  expect(init.exitCode).toBe(0);
  const sync = await runDome(["sync", "--vault", vaultPath, "--json"]);
  expect(sync.exitCode).toBe(0);
  expect(sync.stderr).toBe("");
  return vaultPath;
}

function writeLedger(markdown: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-v1-dogfood-preflight-ledger-"));
  fixtures.push(dir);
  const path = join(dir, "ledger.md");
  writeFileSync(path, markdown.trimStart());
  return path;
}

function completeDay(date: string): string {
  return `
## ${date} Work Session

Operational state:
- \`bin/dome status --vault ~/vaults/work --json\`

Qualitative notes to fill after the work session:
- Daily note usefulness: Started from the daily surface.
- Capture digestion: Processed one raw capture into \`wiki/generated/intake/${date}.md\`.
- Open-loop surfacing: Helpful.
- Context packet quality: Useful.
- Question burden: Low.
- Link/concept hygiene: Known backlog.
- Friction / manual foreground-agent work Dome should own: No manual maintenance today.
- Lost or overwritten human markdown edits: no
- Manual .dome/state edits: no
`.trim();
}

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runDome(args: ReadonlyArray<string>): Promise<ProcessResult> {
  return await runProcess([DOME_BIN, ...args]);
}

async function runPreflight(args: ReadonlyArray<string>): Promise<ProcessResult> {
  return await runProcess([process.execPath, PREFLIGHT_SCRIPT, ...args]);
}

async function runProcess(cmd: ReadonlyArray<string>): Promise<ProcessResult> {
  const proc = Bun.spawn({
    cmd: [...cmd],
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

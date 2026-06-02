import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { commit } from "../../src/git";
import {
  createServeHeartbeatHandle,
  writeServeHeartbeat,
} from "../../src/engine/compiler-host-heartbeat";

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
    expect(result.stdout).toContain("--require-ready");
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
    expect(report.ledger).toBe(ledgerPath);
    expect(report.sessionEvidence.serveCommand).toEqual([
      "bin/dome",
      "serve",
      "--vault",
      vaultPath,
      "--quiet",
      "--poll-interval-ms",
      "1000",
    ]);
    expect(report.sessionEvidence.snapshotCommand).toEqual([
      "bun",
      "run",
      "v1:dogfood-snapshot",
      "--",
      "--vault",
      vaultPath,
      "--date",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    ]);
    expect(report.sessionEvidence.appendCommand).toContain(
      "bun run v1:dogfood-snapshot -- --vault",
    );
    expect(report.sessionEvidence.appendCommand).toContain(`>> ${ledgerPath}`);
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
    expect(report.release.serveHostEvidenceDays).toBe(1);
    expect(report.release.readiness).toContainEqual({
      id: "complete_workdays",
      label: "Complete workdays",
      current: 1,
      required: 10,
      remaining: 9,
      ready: false,
    });
    expect(report.nextActions).toContain(
      "enable dome.intake with a configured model provider before capture dogfood",
    );
    expect(
      report.nextActions.some((action: string) =>
        action.includes("start dome serve while dogfooding") &&
        action.includes("bin/dome serve --vault")
      ),
    ).toBe(true);
    expect(report.nextActions).toContain(
      "collect 9 more complete M10 workday(s) (1/10)",
    );
  }, { timeout: 30_000 });

  test("requires serve host readiness for collection status", async () => {
    const vaultPath = await makeIntakeReadyVault();
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
    expect(report.capture.ready).toBe(true);
    expect(report.serve.ready).toBe(false);
    expect(report.serve.status).toBe("off");
    expect(
      report.nextActions.some((action: string) =>
        action.includes("start dome serve while dogfooding") &&
        action.includes("bin/dome serve --vault")
      ),
    ).toBe(true);
  }, { timeout: 30_000 });

  test("--require-ready exits nonzero when collection readiness fails", async () => {
    const vaultPath = await makeInitializedVault();
    const ledgerPath = writeLedger(completeDay("2026-06-01"));

    const result = await runPreflight([
      "--vault",
      vaultPath,
      "--ledger",
      ledgerPath,
      "--require-ready",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Collection status: not-ready");
  }, { timeout: 30_000 });

  test("--require-ready exits zero when collection readiness passes", async () => {
    const vaultPath = await makeIntakeReadyVault();
    await writeServeHeartbeat({
      vaultPath,
      handle: createServeHeartbeatHandle(),
      branch: "main",
      pollIntervalMs: 10_000,
      operationalIntervalMs: 10_000,
    });
    const ledgerPath = writeLedger(completeDay("2026-06-01"));

    const result = await runPreflight([
      "--vault",
      vaultPath,
      "--ledger",
      ledgerPath,
      "--require-ready",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Collection status: ready");
    expect(result.stdout).toContain("Session evidence:");
    expect(result.stdout).toContain("Serve command:");
    expect(result.stdout).toContain("bin/dome serve --vault");
    expect(result.stdout).toContain("Snapshot command:");
    expect(result.stdout).toContain("bun run v1:dogfood-snapshot");
    expect(result.stdout).toContain(`>> ${ledgerPath}`);
    expect(result.stdout).toContain("Release-soak report:");
    expect(result.stdout).toContain("- Status: not-ready");
  }, { timeout: 30_000 });

  test("passes through status next actions for operational findings", async () => {
    const vaultPath = await makeInitializedVault();
    await writeFile(join(vaultPath, "draft.md"), "# Draft\n", "utf8");
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
    expect(report.operational.ready).toBe(false);
    expect(report.operational.findings).toContain(
      "working tree has 0 modified and 1 untracked file(s)",
    );
    expect(report.nextActions).toContain(
      "Review draft working-tree changes; commit anything Dome should compile. (git status --short)",
    );
  }, { timeout: 30_000 });

  test("routes stale serve heartbeat through serve readiness only", async () => {
    const vaultPath = await makeIntakeReadyVault();
    await writeServeHeartbeat({
      vaultPath,
      handle: createServeHeartbeatHandle(
        new Date("2026-01-01T00:00:00.000Z"),
      ),
      branch: "main",
      pollIntervalMs: 20,
      operationalIntervalMs: 20,
      now: new Date(Date.now() - 10_000),
    });
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
    expect(report.operational.findings).toEqual([]);
    expect(report.capture.ready).toBe(true);
    expect(report.serve.ready).toBe(false);
    expect(report.serve.status).toBe("stale");
    expect(report.serve.findings).toContain(
      "dome serve heartbeat is stale; restart the foreground host",
    );
    expect(report.nextActions).not.toContain(
      "Explain remaining compiler attention across engine health, content diagnostics, and open decisions. (dome check --json)",
    );
    expect(
      report.nextActions.some((action: string) =>
        action.includes("start dome serve while dogfooding") &&
        action.includes("bin/dome serve --vault")
      ),
    ).toBe(true);
  }, { timeout: 30_000 });

  test("requires serve host branch to match the current vault branch", async () => {
    const vaultPath = await makeIntakeReadyVault();
    await writeServeHeartbeat({
      vaultPath,
      handle: createServeHeartbeatHandle(),
      branch: "other-branch",
      pollIntervalMs: 10_000,
      operationalIntervalMs: 10_000,
    });
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
    expect(report.capture.ready).toBe(true);
    expect(report.serve.ready).toBe(false);
    expect(report.serve.status).toBe("running");
    expect(report.serve.branch).toBe("other-branch");
    expect(report.serve.findings).toContain(
      "dome serve is running on branch other-branch, but the vault is on main",
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
    expect(result.stdout).toContain("- Serve-host evidence days: 1");
    expect(result.stdout).toContain("- Remaining criteria:");
    expect(result.stdout).toContain(
      "Complete workdays: need 9 more (1/10)",
    );
    expect(result.stdout).toContain(
      "Complete-workday span: need 11 more calendar day(s) (1/12)",
    );
    expect(result.stdout).toContain("Next actions:");
    expect(result.stdout).toContain(
      "collect 9 more complete M10 workday(s) (1/10)",
    );
    expect(result.stdout).toContain("Serve command:");
    expect(result.stdout).toContain("bin/dome serve --vault");
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

async function makeIntakeReadyVault(): Promise<string> {
  const vaultPath = await makeInitializedVault();
  const configPath = join(vaultPath, ".dome", "config.yaml");
  const configBody = readFileSync(configPath, "utf8");
  const updated = configBody.replace(
    /(^\s+dome\.intake:\s*\n\s+enabled:\s*)false/m,
    "$1true",
  );
  expect(updated).not.toBe(configBody);
  await writeFile(configPath, updated, "utf8");
  await commit({
    path: vaultPath,
    message: "enable intake for preflight\n",
    files: [".dome/config.yaml"],
  });
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
- \`bin/dome query --vault ~/vaults/work "today open loops" --json\`
- Serve host: running; branch main; pid 123; updated 2026-06-01T12:00:00.000Z

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

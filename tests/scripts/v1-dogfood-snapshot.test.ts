import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DOME_BIN = join(REPO_ROOT, "bin", "dome");
const SNAPSHOT_SCRIPT = join(REPO_ROOT, "scripts", "v1-dogfood-snapshot.ts");

const fixtures: string[] = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const path = fixtures.pop();
    if (path !== undefined) await rm(path, { recursive: true, force: true });
  }
});

describe("v1 dogfood snapshot script", () => {
  test("help describes the M10 ledger helper", async () => {
    const result = await runSnapshot(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Emits a read-only Markdown snapshot for the M10 work-vault dogfood ledger.",
    );
  });

  test("emits a dated ledger-ready Markdown snapshot from real CLI surfaces", async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), "dome-v1-dogfood-"));
    fixtures.push(vaultPath);

    expect((await runDome(["init", vaultPath])).exitCode).toBe(0);
    mkdirSync(join(vaultPath, "notes"), { recursive: true });
    writeFileSync(
      join(vaultPath, "notes", "broken-link.md"),
      "# Broken link\n\nSee [[missing thing]] for follow-up.\n",
    );
    expect((await runGit(vaultPath, ["add", "notes/broken-link.md"])).exitCode)
      .toBe(0);
    expect((await runGit(vaultPath, ["commit", "-m", "add broken link"])).exitCode)
      .toBe(0);
    const sync = await runDome(["sync", "--vault", vaultPath, "--json"]);
    expect(sync.exitCode).toBe(0);
    expect(sync.stderr).toBe("");

    const result = await runSnapshot([
      "--vault",
      vaultPath,
      "--date",
      "2026-06-02",
      "--topic",
      "today open loops",
      "--limit",
      "3",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("## 2026-06-02 Dogfood Snapshot");
    expect(result.stdout).toContain("Commands run:");
    expect(result.stdout).toContain(
      `bin/dome today --vault ${vaultPath} --date 2026-06-02 --json`,
    );
    expect(result.stdout).toContain("Operational state:");
    expect(result.stdout).toContain("- Serve host: off");
    expect(result.stdout).toContain("Maintenance loops:");
    expect(result.stdout).toContain("Content hygiene:");
    expect(result.stdout).toContain("- Example findings:");
    expect(result.stdout).toContain("Wikilink [[missing thing]]");
    expect(result.stdout).toContain("Daily surface:");
    expect(result.stdout).toContain("Context packet: `today open loops`");
    expect(result.stdout).toContain("Qualitative notes to fill after the work session:");
    expect(result.stdout).toContain(
      "- Lost or overwritten human markdown edits:",
    );
    expect(result.stdout).toContain("- Manual .dome/state edits:");
    expect(result.stdout).toContain(
      "M10 status: this snapshot is supporting evidence only",
    );
  }, { timeout: 30_000 });
});

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runDome(args: ReadonlyArray<string>): Promise<ProcessResult> {
  return await runProcess([DOME_BIN, ...args]);
}

async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<ProcessResult> {
  return await runProcess([
    "git",
    "-C",
    cwd,
    "-c",
    "user.name=Dome Test",
    "-c",
    "user.email=dome@example.invalid",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
}

async function runSnapshot(args: ReadonlyArray<string>): Promise<ProcessResult> {
  return await runProcess([process.execPath, SNAPSHOT_SCRIPT, ...args]);
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

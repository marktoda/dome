// drain-captures.sh — the laptop half of eventually-consistent phone capture
// (the iCloud-Drive queue the iOS Shortcut falls back to when POST /capture
// cannot reach the host). The script is SDK-shipped vault-side data, wired by
// `dome recipe capture-queue` as a launchd external job — deliberately NOT a
// dome.sources subscription (that contract is one output file per period;
// a drain is many files per run). Test style mirrors the shipped-template
// blocks of tests/extensions/dome.sources/handler.test.ts, adapted: this
// script is not a sources handler, so it is exercised directly against a
// temp vault + temp queue dir with the REAL `bin/dome`.
//
// Pins the contract: $1/$DOME_CAPTURE_QUEUE queue dir; one `dome capture
// --file <f> --capture-id <stem>` per *.md file; delete-on-success;
// failure keeps the file for the next interval; empty/missing queue →
// exit 0 silent; idempotent across a crash between capture and delete
// (the captureId re-run answers duplicate — still exit 0 → still deleted,
// never double-filed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";

const SCRIPT = join(import.meta.dir, "..", "..", "assets", "source-handlers", "drain-captures.sh");
const DOME_BIN = join(import.meta.dir, "..", "..", "bin", "dome");

let vaultPath: string;
let queueDir: string;

beforeEach(async () => {
  vaultPath = mkdtempSync(join(tmpdir(), "dome-drain-vault-"));
  queueDir = mkdtempSync(join(tmpdir(), "dome-drain-queue-"));
  // A real initialized vault: `dome capture` needs the git repo, the
  // scaffold commit, and .dome/config.yaml. Silence runInit's chatter.
  const origLog = console.log;
  console.log = () => {};
  try {
    expect(await runInit({ path: vaultPath })).toBe(0);
  } finally {
    console.log = origLog;
  }
});

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true });
  rmSync(queueDir, { recursive: true, force: true });
});

type DrainResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Run the real script with the real bin/dome, cwd = the vault root. */
async function drain(
  args: ReadonlyArray<string> = [queueDir],
  env: Record<string, string> = {},
): Promise<DrainResult> {
  const proc = Bun.spawn(["sh", SCRIPT, ...args], {
    cwd: vaultPath,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOME_BIN, ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function queueFile(name: string, body: string): string {
  const path = join(queueDir, name);
  writeFileSync(path, body);
  return path;
}

function rawCaptures(): ReadonlyArray<string> {
  try {
    // The init scaffold ships inbox/raw/.gitkeep; only captures are .md.
    return readdirSync(join(vaultPath, "inbox", "raw"))
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

describe("drain-captures.sh (template shape)", () => {
  test("is sh-parseable (sh -n)", async () => {
    const proc = Bun.spawn(["sh", "-n", SCRIPT], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
  });

  test("carries the contract: default queue dir, captureId-from-stem, delete-on-success, recipe-not-subscription", async () => {
    const text = await Bun.file(SCRIPT).text();
    // The iCloud Drive default + the override seams.
    expect(text).toContain("com~apple~CloudDocs/DomeCaptures");
    expect(text).toContain("DOME_CAPTURE_QUEUE");
    // One `dome capture` per file: body from --file, idempotency from
    // --capture-id = the filename stem.
    expect(text).toContain('--file "$f" --capture-id "$id"');
    expect(text).toContain('basename "$f" .md');
    // Delete only on success; failures keep the file for the next interval.
    expect(text).toContain('rm -f -- "$f"');
    expect(text).toContain("kept for retry");
    // The honest-wiring rationale is recorded in the header.
    expect(text).toContain("NOT a");
    expect(text).toContain("dome.sources subscription");
    // Not-yet-downloaded iCloud placeholders get a best-effort download.
    expect(text).toContain("brctl download");
  });
});

describe("drain-captures.sh (behavior against a real vault)", () => {
  test("drains every queued file into inbox/raw and deletes the queue entries", async () => {
    queueFile("2026-06-12-071233-aaaa1111.md", "first queued thought\n");
    queueFile("2026-06-12-081502-bbbb2222.md", "second queued thought\n");

    const result = await drain();

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(readdirSync(queueDir)).toEqual([]);
    const captured = rawCaptures();
    expect(captured.length).toBe(2);
    // captureId = filename stem drives the capture slug.
    expect(captured.some((f) => f.includes("aaaa1111"))).toBe(true);
    expect(captured.some((f) => f.includes("bbbb2222"))).toBe(true);
    // The body landed, not the filename.
    const first = captured.find((f) => f.includes("aaaa1111"));
    const body = await Bun.file(join(vaultPath, "inbox", "raw", first ?? "")).text();
    expect(body).toContain("first queued thought");
  }, 20_000);

  test("crash between capture and delete is idempotent: the re-run answers duplicate and still clears the queue", async () => {
    const name = "2026-06-12-091500-cccc3333.md";
    queueFile(name, "thought captured then crashed\n");

    // First drain: captured + deleted.
    const first = await drain();
    expect(first.exitCode).toBe(0);
    expect(rawCaptures().length).toBe(1);

    // Simulate the crash window: the capture landed but the delete never
    // ran — the queue file is back, same name, same content.
    queueFile(name, "thought captured then crashed\n");

    const second = await drain();
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("duplicate");
    expect(readdirSync(queueDir)).toEqual([]); // cleared again
    expect(rawCaptures().length).toBe(1); // never double-filed
  }, 20_000);

  test("a failing capture keeps the queue file for the next interval and exits non-zero", async () => {
    queueFile("2026-06-12-101500-dddd4444.md", "must survive\n");

    const result = await drain([queueDir], { DOME_BIN: "/usr/bin/false" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("kept for retry");
    expect(readdirSync(queueDir)).toEqual(["2026-06-12-101500-dddd4444.md"]);
    expect(rawCaptures()).toEqual([]);
  });

  test("empty queue dir exits 0 silently", async () => {
    const result = await drain();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("missing queue dir exits 0 silently", async () => {
    const result = await drain([join(queueDir, "does-not-exist")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("the queue dir falls back to $DOME_CAPTURE_QUEUE when no argument is given", async () => {
    queueFile("2026-06-12-111500-eeee5555.md", "env-routed thought\n");

    const result = await drain([], { DOME_CAPTURE_QUEUE: queueDir });

    expect(result.exitCode).toBe(0);
    expect(readdirSync(queueDir)).toEqual([]);
    expect(rawCaptures().length).toBe(1);
  }, 20_000);

  test("non-.md files are left alone", async () => {
    queueFile(".2026-06-12-121500-ffff6666.md.icloud", "placeholder");
    queueFile("notes.txt", "not a capture");

    const result = await drain();

    expect(result.exitCode).toBe(0);
    expect(rawCaptures()).toEqual([]);
    const remaining = readdirSync(queueDir).sort();
    expect(remaining).toContain("notes.txt");
    expect(remaining).toContain(".2026-06-12-121500-ffff6666.md.icloud");
  });
});

import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BoundedCommandError, runBoundedCommand } from "../../src/platform/bounded-command";

test("bounded command passes exact argv and returns captured output for every exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-success-"));
  try {
    const command = await fakeCommand(root);
    const literal = "argument with spaces $(not-a-shell)";
    const success = await runBoundedCommand({
      argv: [command, "success", literal],
      timeoutMs: 3_000,
      outputLimitBytes: Buffer.byteLength(literal),
    });
    expect(success).toEqual({ exitCode: 0, stdout: literal, stderr: "" });

    const nonzero = await runBoundedCommand({
      argv: [command, "nonzero"],
      timeoutMs: 3_000,
      outputLimitBytes: 64,
    });
    expect(nonzero).toEqual({ exitCode: 7, stdout: "bounded stdout", stderr: "bounded stderr" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command stops an output flood while draining both pipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-flood-secret-"));
  try {
    const command = await fakeCommand(root);
    const error = await captureError(runBoundedCommand({
      argv: [command, "flood", "super-secret-argument"],
      timeoutMs: 3_000,
      outputLimitBytes: 1_024,
    }));
    expect(error).toBeInstanceOf(BoundedCommandError);
    expect((error as BoundedCommandError).kind).toBe("output-limit");
    expect((error as BoundedCommandError).stream).toBe("stdout");
    expect(error.message).toContain("exceeded 1024 bytes");
    expect(error.message).not.toContain(root);
    expect(error.message).not.toContain("super-secret-argument");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command enforces the per-stream limit on stderr too", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-stderr-"));
  try {
    const command = await fakeCommand(root);
    const error = await captureError(runBoundedCommand({
      argv: [command, "stderr-flood"],
      timeoutMs: 3_000,
      outputLimitBytes: 1_024,
    }));
    expect(error).toBeInstanceOf(BoundedCommandError);
    expect((error as BoundedCommandError).kind).toBe("output-limit");
    expect((error as BoundedCommandError).stream).toBe("stderr");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command classifies spawn failures with a control-safe basename only", async () => {
  const missing = join(tmpdir(), "owner-secret", "missing\ncommand");
  const error = await captureError(runBoundedCommand({
    argv: [missing, "secret-argument"],
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  }));
  expect(error).toBeInstanceOf(BoundedCommandError);
  expect((error as BoundedCommandError).kind).toBe("spawn");
  expect(error.message).toBe("missing?command could not start");
  expect(error.message).not.toContain("owner-secret");
  expect(error.message).not.toContain("secret-argument");
  expect((error as BoundedCommandError).spawnCode).toBe("ENOENT");
  const observableError = `${error.stack ?? ""}\n${JSON.stringify(error)}`;
  expect(observableError).not.toContain("owner-secret");
  expect(observableError).not.toContain("secret-argument");
});

test("bounded command accepts graceful TERM cleanup before escalation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-term-"));
  try {
    const command = await fakeCommand(root);
    const marker = join(root, "term-marker");
    const error = await captureError(runBoundedCommand({
      argv: [command, "graceful-term", marker],
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
    }));
    expect(error).toBeInstanceOf(BoundedCommandError);
    expect((error as BoundedCommandError).kind).toBe("timeout");
    expect(await readFile(marker, "utf8")).toBe("graceful\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command sends TERM, escalates a trapping child to KILL, and awaits exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-trap-"));
  try {
    const command = await fakeCommand(root);
    const marker = join(root, "term-marker");
    const pidPath = join(root, "pid");
    const startedAt = Date.now();
    const error = await captureError(runBoundedCommand({
      argv: [command, "trap", marker, pidPath],
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
    }));
    expect(error).toBeInstanceOf(BoundedCommandError);
    expect((error as BoundedCommandError).kind).toBe("timeout");
    expect(await readFile(marker, "utf8")).toBe("term\n");
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(processAlive(pid)).toBeFalse();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command deadline includes streams retained by a descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-pipes-"));
  let descendantPid: number | undefined;
  try {
    const command = await fakeCommand(root);
    const pidPath = join(root, "descendant-pid");
    const startedAt = Date.now();
    const error = await captureError(runBoundedCommand({
      argv: [command, "inherited-pipes", pidPath],
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
    }));
    descendantPid = Number(await readFile(pidPath, "utf8"));
    expect(error).toBeInstanceOf(BoundedCommandError);
    expect((error as BoundedCommandError).kind).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  } finally {
    if (descendantPid !== undefined) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command success awaits output closed later by an inherited-pipe descendant", async () => {
  const root = await mkdtemp(join(tmpdir(), "dome-bounded-command-delayed-drain-"));
  try {
    const command = await fakeCommand(root);
    const startedAt = Date.now();
    const result = await runBoundedCommand({
      argv: [command, "delayed-drain"],
      timeoutMs: 3_000,
      outputLimitBytes: 1_024,
    });
    expect(result).toEqual({ exitCode: 0, stdout: "late output", stderr: "" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded command rejects invalid resource bounds before spawning", async () => {
  await expect(runBoundedCommand({ argv: [], timeoutMs: 1, outputLimitBytes: 1 })).rejects.toThrow("argv");
  await expect(runBoundedCommand({ argv: ["command"], timeoutMs: 0, outputLimitBytes: 1 })).rejects.toThrow("timeoutMs");
  await expect(runBoundedCommand({ argv: ["command"], timeoutMs: 24 * 60 * 60 * 1_000 + 1, outputLimitBytes: 1 }))
    .rejects.toThrow("timeoutMs");
  await expect(runBoundedCommand({ argv: ["command"], timeoutMs: 1, outputLimitBytes: 0 })).rejects.toThrow("outputLimitBytes");
  await expect(runBoundedCommand({ argv: ["command"], timeoutMs: 1, outputLimitBytes: 16 * 1024 * 1024 + 1 }))
    .rejects.toThrow("outputLimitBytes");
});

async function fakeCommand(root: string): Promise<string> {
  const command = join(root, "fake-command");
  await writeFile(command, `#!${process.execPath}
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode === "success") {
  process.stdout.write(process.argv[3] ?? "");
} else if (mode === "nonzero") {
  process.stdout.write("bounded stdout");
  process.stderr.write("bounded stderr");
  process.exit(7);
} else if (mode === "flood") {
  for (;;) process.stdout.write("x".repeat(4_096));
} else if (mode === "stderr-flood") {
  for (;;) process.stderr.write("x".repeat(4_096));
} else if (mode === "graceful-term") {
  process.on("SIGTERM", () => {
    writeFileSync(process.argv[3]!, "graceful\\n");
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (mode === "trap") {
  writeFileSync(process.argv[4]!, String(process.pid));
  process.on("SIGTERM", () => { writeFileSync(process.argv[3]!, "term\\n"); });
  setInterval(() => {}, 1_000);
} else if (mode === "inherited-pipes") {
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 2_000)"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  writeFileSync(process.argv[3]!, String(child.pid));
  process.exit(0);
} else if (mode === "delayed-drain") {
  Bun.spawn([process.execPath, "-e", "setTimeout(() => process.stdout.write('late output'), 150)"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(0);
} else {
  process.exit(64);
}
`);
  await chmod(command, 0o755);
  return command;
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error("expected bounded command to fail");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

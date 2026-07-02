// sources.fetch — the dome.sources external handler (wiki/specs/sources.md
// §"The handler contract" + §"Consent is re-checked at dispatch"), exercised
// with FAKE fetch commands only (tiny shell scripts in a temp vault — never
// a real model or network fetch).
//
// Pins the contract order: payload validation (defense in depth — the
// outbox row is data, including the `.md` / `sources/` symmetry with the
// processor), consent re-derivation from the live config (revocation kills
// queued rows; a mismatched command never runs), HEAD-based crash recovery
// (committed → recovered; written-but-uncommitted does NOT recover and the
// retry's commit-only path completes it), spawn with cwd = vault root +
// appended <date> <output_path> args, stdout ignored (a >64KB-chatty
// fetcher must not deadlock), non-zero exit → throw (stderr excerpt),
// exit-0-without-a-COMMIT → throw, and abort → process-group SIGTERM with
// SIGKILL escalation (a TERM-trapping script and its grandchildren die).
// The outbox blocks drive the handler through the REAL dispatch path so
// the bounded-retry semantics are pinned end to end
// (EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sourcesFetch from "../../../assets/extensions/dome.sources/external-handlers/sources.fetch";
import { externalActionEffect } from "../../../src/core/effect";
import { openOutboxDb, type OutboxDb } from "../../../src/outbox/db";
import {
  dispatchExternalEffect,
  type ExternalHandlerInput,
} from "../../../src/outbox/dispatch";

let vaultPath: string;

function git(...args: ReadonlyArray<string>): string {
  return execFileSync("git", [...args], { cwd: vaultPath, encoding: "utf8" });
}

/** True when the vault-relative path exists as a blob in HEAD. */
function inHead(path: string): boolean {
  try {
    git("cat-file", "-e", `HEAD:${path}`);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "dome-sources-handler-"));
  mkdirSync(join(vaultPath, ".dome", "bin"), { recursive: true });
  // Every vault is a git repo (the axiom) — the handler verifies fetch
  // completion against HEAD, so the fixture is a real one. Hermetic
  // identity + no signing so the developer's global git config never
  // reaches the fake commands.
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Handler Test");
  git("config", "user.email", "handler@test.invalid");
  git("config", "commit.gpgsign", "false");
});

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true });
});

const PAYLOAD = {
  kind: "calendar",
  date: "2026-06-10",
  output_path: "sources/calendar/2026-06-10.md",
} as const;

const OUTPUT_PATH = PAYLOAD.output_path;

/** The contract-conforming landing: write, then pathspec-commit. */
const WRITE_AND_COMMIT = `mkdir -p "$(dirname "$2")"
echo agenda > "$2"
git add -- "$2"
git commit -q --no-verify -m "calendar: agenda for $1" -- "$2"`;

function input(
  overrides: Partial<ExternalHandlerInput> & { readonly payload: unknown },
): ExternalHandlerInput {
  return {
    capability: "sources.fetch",
    idempotencyKey: "dome.sources:calendar:2026-06-10",
    sourceRefs: [],
    runId: "run-handler-test",
    attempt: 1,
    signal: new AbortController().signal,
    vaultPath,
    ...overrides,
  };
}

/** Install a fake fetch script and return the subscription-style command. */
function fakeCommand(script: string): ReadonlyArray<string> {
  const path = join(vaultPath, ".dome", "bin", "fake-fetch.sh");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return [".dome/bin/fake-fetch.sh"];
}

/**
 * Install a fake `claude` on a throwaway bin dir and return a PATH that puts
 * it ahead of the system tools the templates need (awk, git, sh). The fake
 * ignores its args and prints `stdout` verbatim — the FETCH block in the
 * shipped templates is `claude ... > "$tmp"`, so this is exactly what the
 * REPAIR + VALIDATE steps then see. `printf %s` (no trailing newline) lets a
 * case control its output bytes precisely.
 */
function fakeClaudePath(stdout: string): string {
  const binDir = join(vaultPath, ".dome", "fakebin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "claude");
  // Single-quote the heredoc body so the payload is emitted literally.
  writeFileSync(
    path,
    `#!/bin/sh\ncat <<'DOME_FAKE_CLAUDE_EOF'\n${stdout}\nDOME_FAKE_CLAUDE_EOF\n`,
  );
  chmodSync(path, 0o755);
  return `${binDir}:/usr/bin:/bin`;
}

/**
 * Install a fake `icalbuddy` on a throwaway bin dir and return a PATH that
 * puts it ahead of the system tools the icalbuddy-calendar.sh template
 * needs (awk, git, sh). The fake ignores its args (flags, `eventsFrom:...
 * to:...`) and prints `stdout` verbatim with the given exit code — the
 * FETCH block in the shipped template is `icalbuddy ... > "$tmp_ical"`, so
 * this is exactly what the transform + validation steps then see.
 */
function fakeIcalbuddyPath(
  stdout: string,
  opts: { readonly exitCode?: number } = {},
): string {
  const binDir = join(vaultPath, ".dome", "fakebin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "icalbuddy");
  const exitCode = opts.exitCode ?? 0;
  // Single-quote the heredoc body so the payload is emitted literally.
  writeFileSync(
    path,
    `#!/bin/sh\ncat <<'DOME_FAKE_ICALBUDDY_EOF'\n${stdout}\nDOME_FAKE_ICALBUDDY_EOF\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return `${binDir}:/usr/bin:/bin`;
}

/**
 * Write the consent surface: `.dome/config.yaml` with one dome.sources
 * subscription. The handler re-derives the subscription from THIS file at
 * dispatch time; tests that want a consent mismatch pass different values
 * here than in the payload.
 */
function consent(
  command: ReadonlyArray<string>,
  opts: {
    readonly kind?: string;
    readonly outputPath?: string;
    readonly subscriptionEnabled?: boolean;
    readonly extensionEnabled?: boolean;
  } = {},
): void {
  const kind = opts.kind ?? "calendar";
  writeFileSync(
    join(vaultPath, ".dome", "config.yaml"),
    [
      "extensions:",
      "  dome.sources:",
      `    enabled: ${opts.extensionEnabled ?? true}`,
      "    config:",
      "      subscriptions:",
      `        ${kind}:`,
      `          enabled: ${opts.subscriptionEnabled ?? true}`,
      '          schedule: "10 5 * * *"',
      `          output_path: "${opts.outputPath ?? "sources/calendar/{date}.md"}"`,
      `          command: ${JSON.stringify(command)}`,
      "    grant:",
      '      external: ["sources.fetch"]',
      "",
    ].join("\n"),
  );
}

describe("sources.fetch handler contract", () => {
  test("spawns the command from the vault root with date + output path appended", async () => {
    const command = fakeCommand(
      // Record the args + cwd, then fulfil the contract (write + commit $2).
      `printf "%s|%s|%s" "$1" "$2" "$(pwd)" > args.txt\n${WRITE_AND_COMMIT}`,
    );
    consent(command);
    const result = await sourcesFetch(
      input({ payload: { ...PAYLOAD, command } }),
    );

    expect(result).toEqual({ externalId: "calendar:2026-06-10" });
    const recorded = await Bun.file(join(vaultPath, "args.txt")).text();
    const [date, outputPath, cwd] = recorded.split("|");
    expect(date).toBe("2026-06-10");
    expect(outputPath).toBe(OUTPUT_PATH);
    // Resolve via realpath-insensitive suffix check (tmpdir may be symlinked).
    expect(cwd?.endsWith(vaultPath.split("/").slice(-1)[0]!)).toBe(true);
    expect(inHead(OUTPUT_PATH)).toBe(true);
  });

  test("output committed at HEAD returns recovered without spawning", async () => {
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(join(vaultPath, OUTPUT_PATH), "# already fetched\n");
    git("add", "--", OUTPUT_PATH);
    git("commit", "-q", "--no-verify", "-m", "calendar: agenda", "--", OUTPUT_PATH);
    // A command that would explode if spawned proves the no-spawn path.
    const command = fakeCommand("echo should-not-run > spawned.txt\nexit 1");
    consent(command);

    const result = await sourcesFetch(
      input({ payload: { ...PAYLOAD, command } }),
    );
    expect(result).toEqual({
      externalId: "calendar:2026-06-10",
      recovered: true,
    });
    expect(await Bun.file(join(vaultPath, "spawned.txt")).exists()).toBe(false);
  });

  test("output in the working tree but NOT in HEAD does not recover — the command runs and commit-only completes it", async () => {
    // A prior attempt wrote the file but its commit failed. The handler
    // must spawn (not mark recovered), and the contract-conforming command
    // skips the fetch and just commits what is there.
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(join(vaultPath, OUTPUT_PATH), "# written, never committed\n");
    const command = fakeCommand(
      `if [ ! -e "$2" ]; then echo "fetched again instead of commit-only" >&2; exit 1; fi
git add -- "$2"
git commit -q --no-verify -m "calendar: agenda for $1" -- "$2"`,
    );
    consent(command);

    const result = await sourcesFetch(
      input({ payload: { ...PAYLOAD, command } }),
    );
    expect(result).toEqual({ externalId: "calendar:2026-06-10" });
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(await Bun.file(join(vaultPath, OUTPUT_PATH)).text()).toBe(
      "# written, never committed\n",
    );
  });

  test("exit 0 with the file written but uncommitted throws — write-without-commit is incomplete, never sent", async () => {
    const command = fakeCommand('mkdir -p "$(dirname "$2")"\necho agenda > "$2"');
    consent(command);
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/did not commit/);
    // The dirt is still there for the retry's commit-only path.
    expect(existsSync(join(vaultPath, OUTPUT_PATH))).toBe(true);
    expect(inHead(OUTPUT_PATH)).toBe(false);
  });

  test("non-zero exit throws with the stderr excerpt (ordinary outbox retry)", async () => {
    const command = fakeCommand('echo "calendar API said no" >&2\nexit 7');
    consent(command);
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/exited 7.*calendar API said no/s);
  });

  test("exit 0 without the output file throws — a silent no-op fetch is visible", async () => {
    const command = fakeCommand("exit 0");
    consent(command);
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/exited 0 but did not write sources\/calendar\/2026-06-10\.md/);
  });

  test("a >64KB stdout flood completes — stdout is ignored, never a deadlocked pipe", async () => {
    const command = fakeCommand(
      // ~200KB of stdout chatter, far past the ~64KB pipe buffer that
      // deadlocked the old piped-but-never-drained spawn.
      `head -c 200000 /dev/zero | tr '\\0' 'x'\n${WRITE_AND_COMMIT}`,
    );
    consent(command);
    const result = await sourcesFetch(
      input({ payload: { ...PAYLOAD, command } }),
    );
    expect(result).toEqual({ externalId: "calendar:2026-06-10" });
  }, 10_000);

  test("abort SIGTERMs the process group and escalates to SIGKILL — a TERM-trapping child and its grandchild both die", async () => {
    const command = fakeCommand(
      // Both the script AND its grandchild trap (ignore) SIGTERM, so only
      // the SIGKILL escalation can end them — and the grandchild is one
      // process deeper than the spawned child (handler → sh → sh → sleep),
      // so only a process-GROUP kill reaches it at all.
      [
        "sh -c 'trap \"\" TERM; sleep 30' &",
        "echo $! > sleeper.pid",
        'trap "" TERM',
        "wait",
      ].join("\n"),
    );
    consent(command);
    const controller = new AbortController();
    const pending = sourcesFetch(
      input({ payload: { ...PAYLOAD, command }, signal: controller.signal }),
    );
    // Abort only once the script is demonstrably running (it has recorded
    // the grandchild pid) — aborting mid-startup would race the trap.
    const readyDeadline = Date.now() + 5_000;
    while (!existsSync(join(vaultPath, "sleeper.pid"))) {
      if (Date.now() > readyDeadline) throw new Error("fake fetch never started");
      await Bun.sleep(10);
    }
    const startedAt = Date.now();
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    // The escalation grace is 500ms; well under the 30s the traps were
    // shielding. Generous bound to stay unflaky under load.
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    const sleeperPid = Number.parseInt(
      (await Bun.file(join(vaultPath, "sleeper.pid")).text()).trim(),
      10,
    );
    expect(Number.isInteger(sleeperPid)).toBe(true);
    // SIGKILL delivery is asynchronous; poll briefly for the grandchild
    // to disappear instead of asserting instantaneous death.
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      try {
        process.kill(sleeperPid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 10_000);

  test("requires the engine-injected vaultPath (bundle-handler wrapping)", async () => {
    const base = input({ payload: { ...PAYLOAD, command: ["true"] } });
    const { vaultPath: _omitted, ...withoutVault } = base;
    await expect(sourcesFetch(withoutVault)).rejects.toThrow(/vaultPath/);
  });

  test("re-rejects payloads that could escape the vault or the sources/ category (the row is data)", async () => {
    const cases: ReadonlyArray<unknown> = [
      null,
      { ...PAYLOAD },                                            // no command
      { ...PAYLOAD, command: [] },                               // empty command
      { ...PAYLOAD, command: ["x"], kind: "" },                  // empty kind
      { ...PAYLOAD, command: ["x"], date: "June 10" },           // bad date
      { ...PAYLOAD, command: ["x"], output_path: "/etc/x.md" },  // absolute
      { ...PAYLOAD, command: ["x"], output_path: "../x.md" },    // escape
      { ...PAYLOAD, command: ["x"], output_path: "a\\b.md" },    // backslash
      { ...PAYLOAD, command: ["x"], output_path: "sources/x.txt" },   // not .md
      { ...PAYLOAD, command: ["x"], output_path: "notes/2026.md" },   // outside sources/
    ];
    for (const payload of cases) {
      await expect(sourcesFetch(input({ payload }))).rejects.toThrow();
    }
  });
});

describe("the shipped claude-calendar.sh template", () => {
  test("commit-only retry: when the output file already exists the template commits it without fetching", async () => {
    // The fixture has no `claude` on PATH-by-proxy: if the template tried
    // to fetch, it would exit non-zero. Exit 0 + a new HEAD blob proves
    // the fetch was skipped and the existing file just got committed.
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, OUTPUT_PATH),
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
    const template = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "assets",
      "source-handlers",
      "claude-calendar.sh",
    );
    const proc = Bun.spawn(["sh", template, PAYLOAD.date, OUTPUT_PATH], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: "/usr/bin:/bin" }, // no claude here
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).not.toContain("claude");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(git("log", "-1", "--pretty=%s")).toContain(
      "calendar: agenda for 2026-06-10",
    );
  });

  test("gpg immunity: lands unsigned even when the vault config demands commit signing", async () => {
    // The second-user day-one hazard: a vault inheriting commit.gpgsign=true
    // (usually from the global config) would make a plain `git commit` try
    // to sign — non-interactive, no agent, fetch dies. The template's land()
    // commits with `-c commit.gpgsign=false`, so a broken gpg setup can
    // never reach it: point gpg.program at a nonexistent binary and the
    // commit must still land, unsigned.
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", "/nonexistent/gpg-not-here");
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, OUTPUT_PATH),
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
    const template = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "assets",
      "source-handlers",
      "claude-calendar.sh",
    );
    const proc = Bun.spawn(["sh", template, PAYLOAD.date, OUTPUT_PATH], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    // The landed commit is unsigned (no gpgsig header on the object).
    expect(git("cat-file", "commit", "HEAD")).not.toContain("gpgsig");
  });

  test("pathspec commit: staged human work is never swept into the fetch commit", async () => {
    // A human has STAGED unrelated work when the fetch lands. The
    // template's `git commit -- "$f"` must commit only the agenda.
    writeFileSync(join(vaultPath, "notes.md"), "# human work in flight\n");
    git("add", "--", "notes.md");
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, OUTPUT_PATH),
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
    const template = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "assets",
      "source-handlers",
      "claude-calendar.sh",
    );
    const proc = Bun.spawn(["sh", template, PAYLOAD.date, OUTPUT_PATH], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect(await proc.exited).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(inHead("notes.md")).toBe(false); // still only staged
    const staged = git("diff", "--cached", "--name-only");
    expect(staged).toContain("notes.md");
  });

  // ---- REPAIR (the live bug) ------------------------------------------------
  // The headless model returns CORRECT content but sometimes wrapped in a ```
  // fence and/or behind a chatty preamble, so the raw first line is the fence
  // (not `---`) and VALIDATE fails every run — three outbox rows were wedged
  // live. The deterministic REPAIR step between FETCH and VALIDATE normalizes
  // the output; these drive the WHOLE template (FETCH via a fake `claude` →
  // REPAIR → VALIDATE → LAND) so the gate stays a gate.
  const calendarTemplate = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "assets",
    "source-handlers",
    "claude-calendar.sh",
  );
  const CAL_DAY =
    "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10";

  async function runCalendar(fetchStdout: string) {
    const proc = Bun.spawn(
      ["sh", calendarTemplate, PAYLOAD.date, OUTPUT_PATH],
      {
        cwd: vaultPath,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, PATH: fakeClaudePath(fetchStdout) },
      },
    );
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stderrText };
  }

  test("REPAIR: fence-wrapped valid content is unwrapped, validates, and lands", async () => {
    const { exitCode, stderrText } = await runCalendar(
      "```\n" + CAL_DAY + "\n```",
    );
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(git("show", `HEAD:${OUTPUT_PATH}`)).toBe(CAL_DAY + "\n");
  });

  test("REPAIR: a ```markdown fence behind a chatty preamble is stripped, validates, and lands", async () => {
    const { exitCode, stderrText } = await runCalendar(
      "Here's your calendar for today:\n```markdown\n" + CAL_DAY + "\n```",
    );
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(git("show", `HEAD:${OUTPUT_PATH}`)).toBe(CAL_DAY + "\n");
  });

  test("REPAIR: bare preamble (no fence) before the frontmatter is dropped", async () => {
    const { exitCode } = await runCalendar(
      "Sure, here is the agenda:\n" + CAL_DAY,
    );
    expect(exitCode).toBe(0);
    expect(git("show", `HEAD:${OUTPUT_PATH}`)).toBe(CAL_DAY + "\n");
  });

  test("REPAIR is not a bypass: genuinely broken output (no frontmatter even after repair) still fails the gate", async () => {
    const { exitCode, stderrText } = await runCalendar(
      "I'm sorry, I could not access your calendar today.",
    );
    expect(exitCode).not.toBe(0);
    expect(stderrText).toContain("not a calendar-day file");
    expect(inHead(OUTPUT_PATH)).toBe(false);
  });

  test("REPAIR: already-correct bare frontmatter passes through unchanged", async () => {
    const { exitCode } = await runCalendar(CAL_DAY);
    expect(exitCode).toBe(0);
    expect(git("show", `HEAD:${OUTPUT_PATH}`)).toBe(CAL_DAY + "\n");
  });
});

describe("the shipped icalbuddy-calendar.sh template", () => {
  // The deterministic daemon-safe calendar fetcher: no REPAIR stage (there
  // is no model output to unwrap — icalBuddy either emits parseable agenda
  // lines or fails outright), so this describe drives FETCH -> VALIDATE ->
  // LAND directly through a fake `icalbuddy` PATH shim.
  const icalTemplate = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "assets",
    "source-handlers",
    "icalbuddy-calendar.sh",
  );

  async function runIcalbuddy(
    icalStdout: string,
    opts: { readonly exitCode?: number } = {},
  ) {
    const proc = Bun.spawn(
      ["sh", icalTemplate, PAYLOAD.date, OUTPUT_PATH],
      {
        cwd: vaultPath,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, PATH: fakeIcalbuddyPath(icalStdout, opts) },
      },
    );
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stderrText };
  }

  test("commit-only retry: when the output file already exists the template commits it without fetching", async () => {
    // The fixture has no `icalbuddy` on PATH: if the template tried to
    // fetch, it would exit non-zero (command not found). Exit 0 + a new
    // HEAD blob proves the fetch was skipped and the existing file just
    // got committed.
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, OUTPUT_PATH),
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
    const proc = Bun.spawn(
      ["sh", icalTemplate, PAYLOAD.date, OUTPUT_PATH],
      {
        cwd: vaultPath,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, PATH: "/usr/bin:/bin" }, // no icalbuddy here
      },
    );
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).not.toContain("icalbuddy");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(git("log", "-1", "--pretty=%s")).toContain(
      "calendar: agenda for 2026-06-10",
    );
  });

  test("gpg immunity: lands unsigned even when the vault config demands commit signing", async () => {
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", "/nonexistent/gpg-not-here");
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, OUTPUT_PATH),
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
    const proc = Bun.spawn(
      ["sh", icalTemplate, PAYLOAD.date, OUTPUT_PATH],
      {
        cwd: vaultPath,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      },
    );
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(git("cat-file", "commit", "HEAD")).not.toContain("gpgsig");
  });

  test("pathspec commit: staged human work is never swept into the fetch commit", async () => {
    writeFileSync(join(vaultPath, "notes.md"), "# human work in flight\n");
    git("add", "--", "notes.md");
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(
      join(vaultPath, OUTPUT_PATH),
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
    const proc = Bun.spawn(
      ["sh", icalTemplate, PAYLOAD.date, OUTPUT_PATH],
      {
        cwd: vaultPath,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      },
    );
    expect(await proc.exited).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    expect(inHead("notes.md")).toBe(false); // still only staged
    const staged = git("diff", "--cached", "--name-only");
    expect(staged).toContain("notes.md");
  });

  test("transform: timed meetings with and without attendees, plus an all-day event, parse into the calendar-day shape", async () => {
    // A captured icalBuddy-style sample: emitted by
    // `-npn -nc -nrd -b '- ' -iep "datetime,title,attendees" -po
    // "datetime,title,attendees" -ps '| — |' -tf '%H:%M' -df ''` — a timed
    // meeting with attendees, a timed meeting without, and an all-day event
    // (no datetime property at all).
    const fixture = [
      "- 09:00 - 09:30 — Standup — Alice, Bob",
      "- 14:00 - 14:30 — Solo Sync",
      "- Company Holiday",
    ].join("\n");
    const { exitCode, stderrText } = await runIcalbuddy(fixture);
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    const written = git("show", `HEAD:${OUTPUT_PATH}`);
    expect(written).toContain("---\ntype: calendar-day\ndate: 2026-06-10\n---");
    expect(written).toContain("# Calendar 2026-06-10");
    expect(written).toContain(
      "- 09:00–09:30 — Standup (attendees: Alice, Bob)",
    );
    expect(written).toContain("- 14:00–14:30 — Solo Sync");
    expect(written).not.toContain("14:30 — Solo Sync (attendees:");
    // All-day: title-only bullet, no leading time, no attendees suffix.
    expect(written).toContain("- Company Holiday");
    expect(written).not.toContain("(attendees: )");
  });

  test("empty agenda: zero events still writes and commits frontmatter + heading only", async () => {
    const { exitCode, stderrText } = await runIcalbuddy("");
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(OUTPUT_PATH)).toBe(true);
    const written = git("show", `HEAD:${OUTPUT_PATH}`);
    expect(written).toBe(
      "---\ntype: calendar-day\ndate: 2026-06-10\n---\n\n# Calendar 2026-06-10\n",
    );
  });

  test("validation gate: icalbuddy failure (e.g. Calendar-access denial) exits non-zero and lands nothing", async () => {
    // Simulates the TCC-denial failure mode: icalBuddy exits non-zero
    // instead of emitting an agenda. Without checking icalbuddy's own exit
    // status (as opposed to the exit status of a trailing `| awk` stage,
    // which would mask it), this would silently look like an empty agenda.
    const { exitCode, stderrText } = await runIcalbuddy(
      "icalBuddy: Calendar access denied",
      { exitCode: 1 },
    );
    expect(exitCode).not.toBe(0);
    expect(stderrText).toContain("icalbuddy");
    expect(inHead(OUTPUT_PATH)).toBe(false);
  });
});

describe("the shipped claude-slack.sh template", () => {
  const SLACK_DATE = "2026-06-10";
  const SLACK_OUTPUT = "sources/slack/2026-06-10.md";
  const SLACK_DAY_FILE =
    "---\ntype: slack-day\ndate: 2026-06-10\n---\n\n# Slack 2026-06-10\n";
  const template = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "assets",
    "source-handlers",
    "claude-slack.sh",
  );

  test("is sh-parseable (sh -n)", async () => {
    const proc = Bun.spawn(["sh", "-n", template], {
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

  test("carries the consent header, the digest prompt, and the slack-day validation", async () => {
    const text = await Bun.file(template).text();
    // Consent surface: the header names the claude CLI + the owner's Slack
    // MCP and frames the script itself as the consent surface.
    expect(text).toContain("Slack MCP");
    expect(text).toContain("consent");
    // The fetch prompt asks for the three slack-day sections since the
    // previous evening, the document and nothing else, ~30 items.
    expect(text).toContain("claude -p --output-format text");
    expect(text).toContain("## Mentions");
    expect(text).toContain("## Direct messages");
    expect(text).toContain("## Channels");
    expect(text).toContain("previous local evening");
    expect(text).toContain("30 items");
    expect(text).toContain("type: slack-day");
    // VALIDATE: frontmatter fence, the date line, and the day heading.
    expect(text).toContain("grep -q '^---$'");
    expect(text).toContain('grep -q "^date: $d$"');
    expect(text).toContain('grep -q "^# Slack $d$"');
    // LAND: pathspec-scoped, signing-immune commit with the slack subject.
    expect(text).toContain(
      'git -c commit.gpgsign=false commit -m "slack: overnight digest for $d" -- "$f"',
    );
  });

  test("gpg immunity: lands unsigned even when the vault config demands commit signing", async () => {
    // Same hazard + fix as the calendar template (see that test): land()
    // must be immune to inherited commit.gpgsign=true.
    git("config", "commit.gpgsign", "true");
    git("config", "gpg.program", "/nonexistent/gpg-not-here");
    mkdirSync(join(vaultPath, "sources", "slack"), { recursive: true });
    writeFileSync(join(vaultPath, SLACK_OUTPUT), SLACK_DAY_FILE);
    const proc = Bun.spawn(["sh", template, SLACK_DATE, SLACK_OUTPUT], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(SLACK_OUTPUT)).toBe(true);
    expect(git("cat-file", "commit", "HEAD")).not.toContain("gpgsig");
  });

  test("commit-only retry: when the output file already exists the template commits it without fetching", async () => {
    // No `claude` on the PATH: if the template tried to fetch, it would exit
    // non-zero. Exit 0 + a new HEAD blob proves the fetch was skipped and the
    // existing file just got committed.
    mkdirSync(join(vaultPath, "sources", "slack"), { recursive: true });
    writeFileSync(join(vaultPath, SLACK_OUTPUT), SLACK_DAY_FILE);
    const proc = Bun.spawn(["sh", template, SLACK_DATE, SLACK_OUTPUT], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: "/usr/bin:/bin" }, // no claude here
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(stderrText).not.toContain("claude");
    expect(exitCode).toBe(0);
    expect(inHead(SLACK_OUTPUT)).toBe(true);
    expect(git("log", "-1", "--pretty=%s")).toContain(
      "slack: overnight digest for 2026-06-10",
    );
  });

  test("pathspec commit: staged human work is never swept into the fetch commit", async () => {
    writeFileSync(join(vaultPath, "notes.md"), "# human work in flight\n");
    git("add", "--", "notes.md");
    mkdirSync(join(vaultPath, "sources", "slack"), { recursive: true });
    writeFileSync(join(vaultPath, SLACK_OUTPUT), SLACK_DAY_FILE);
    const proc = Bun.spawn(["sh", template, SLACK_DATE, SLACK_OUTPUT], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });
    expect(await proc.exited).toBe(0);
    expect(inHead(SLACK_OUTPUT)).toBe(true);
    expect(inHead("notes.md")).toBe(false); // still only staged
    const staged = git("diff", "--cached", "--name-only");
    expect(staged).toContain("notes.md");
  });

  // ---- REPAIR ---------------------------------------------------------------
  // Same fragility as the calendar template (it validates `^---$` first line
  // too): a fenced/preamble-wrapped slack-day document fails VALIDATE without
  // the deterministic REPAIR step. Drive the whole template through a fake
  // `claude` so REPAIR runs between FETCH and VALIDATE.
  const SLACK_DAY =
    "---\ntype: slack-day\ndate: 2026-06-10\n---\n\n# Slack 2026-06-10";

  async function runSlack(fetchStdout: string) {
    const proc = Bun.spawn(["sh", template, SLACK_DATE, SLACK_OUTPUT], {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: fakeClaudePath(fetchStdout) },
    });
    const [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stderrText };
  }

  test("REPAIR: fence-wrapped valid content is unwrapped, validates, and lands", async () => {
    const { exitCode, stderrText } = await runSlack(
      "```\n" + SLACK_DAY + "\n```",
    );
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(inHead(SLACK_OUTPUT)).toBe(true);
    expect(git("show", `HEAD:${SLACK_OUTPUT}`)).toBe(SLACK_DAY + "\n");
  });

  test("REPAIR: a ```markdown fence behind a chatty preamble is stripped, validates, and lands", async () => {
    const { exitCode, stderrText } = await runSlack(
      "Here's your Slack digest:\n```markdown\n" + SLACK_DAY + "\n```",
    );
    expect(stderrText).toBe("");
    expect(exitCode).toBe(0);
    expect(git("show", `HEAD:${SLACK_OUTPUT}`)).toBe(SLACK_DAY + "\n");
  });

  test("REPAIR is not a bypass: genuinely broken output still fails the slack-day gate", async () => {
    const { exitCode, stderrText } = await runSlack(
      "I could not reach your Slack workspace this morning.",
    );
    expect(exitCode).not.toBe(0);
    expect(stderrText).toContain("not a slack-day file");
    expect(inHead(SLACK_OUTPUT)).toBe(false);
  });

  test("REPAIR: already-correct bare frontmatter passes through unchanged", async () => {
    const { exitCode } = await runSlack(SLACK_DAY);
    expect(exitCode).toBe(0);
    expect(git("show", `HEAD:${SLACK_OUTPUT}`)).toBe(SLACK_DAY + "\n");
  });
});

describe("sources.fetch consent re-derivation (the config is the consent surface)", () => {
  test("no .dome/config.yaml at dispatch time refuses the row", async () => {
    const command = fakeCommand(WRITE_AND_COMMIT);
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/no enabled "calendar" subscription/);
  });

  test("a subscription disabled between emit and dispatch refuses the row (revocation is immediate)", async () => {
    const command = fakeCommand(WRITE_AND_COMMIT);
    consent(command, { subscriptionEnabled: false });
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/consent revoked or config changed/);
  });

  test("the dome.sources extension disabled between emit and dispatch refuses the row", async () => {
    const command = fakeCommand(WRITE_AND_COMMIT);
    consent(command, { extensionEnabled: false });
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/extension is not enabled/);
  });

  test("a payload command that no longer matches the config never runs (no arbitrary-exec via the row)", async () => {
    const payloadCommand = fakeCommand(
      "echo pwned > forged-marker.txt\nexit 0",
    );
    // The live config consents to a DIFFERENT command than the row carries.
    consent(["sh", ".dome/bin/some-other-fetch.sh"]);
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command: payloadCommand } })),
    ).rejects.toThrow(/does not match the configured subscription command/);
    expect(existsSync(join(vaultPath, "forged-marker.txt"))).toBe(false);
  });

  test("a rendered output_path that no longer matches the config refuses the row", async () => {
    const command = fakeCommand(WRITE_AND_COMMIT);
    consent(command, { outputPath: "sources/calendar-v2/{date}.md" });
    await expect(
      sourcesFetch(input({ payload: { ...PAYLOAD, command } })),
    ).rejects.toThrow(/output_path .* does not match/);
  });
});

describe("sources.fetch through the real outbox (retry semantics)", () => {
  let db: OutboxDb;

  beforeEach(async () => {
    const opened = await openOutboxDb({
      path: join(vaultPath, ".dome", "state", "outbox.db"),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("outbox open failed");
    db = opened.value.db;
  });

  afterEach(() => {
    db.close();
  });

  function handlers() {
    return new Map([
      [
        "sources.fetch",
        (handlerInput: ExternalHandlerInput) =>
          sourcesFetch({ ...handlerInput, vaultPath }),
      ],
    ]);
  }

  function effectFor(command: ReadonlyArray<string>) {
    return externalActionEffect({
      capability: "sources.fetch",
      idempotencyKey: "dome.sources:calendar:2026-06-10",
      payload: { ...PAYLOAD, command },
      sourceRefs: [],
    });
  }

  test("failing fetch lands pending with backoff; the retry pump re-dispatches to sent", async () => {
    // Fail until the marker file exists, then succeed — two real attempts.
    const command = fakeCommand(
      `if [ ! -f attempt.marker ]; then touch attempt.marker; echo "transient" >&2; exit 1; fi\n${WRITE_AND_COMMIT}`,
    );
    consent(command);
    const effect = effectFor(command);

    const t0 = new Date("2026-06-10T05:15:00.000Z");
    const first = await dispatchExternalEffect(db, {
      effect,
      runId: "run-1",
      handlers: handlers(),
      now: t0,
    });
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") throw new Error("expected pending");
    expect(first.attempts).toBe(1);
    expect(first.lastError).toContain("transient");

    // The 15-minute fetch tick re-emits the same key; before the backoff
    // cursor the row is left alone (already-pending rows are only retried
    // once next_attempt_at passes), after it the retry succeeds.
    const afterBackoff = new Date(first.nextAttemptAt);
    const second = await dispatchExternalEffect(db, {
      effect,
      runId: "run-2",
      handlers: handlers(),
      now: new Date(afterBackoff.getTime() + 1000),
    });
    expect(second.kind).toBe("sent");
    if (second.kind !== "sent") throw new Error("expected sent");
    expect(second.externalId).toBe("calendar:2026-06-10");
    expect(inHead(OUTPUT_PATH)).toBe(true);

    // A third emission returns the cached result without re-spawning.
    const third = await dispatchExternalEffect(db, {
      effect,
      runId: "run-3",
      handlers: handlers(),
      now: new Date(afterBackoff.getTime() + 2000),
    });
    expect(third.kind).toBe("already-sent");
  });

  test("write-without-commit fails the attempt; the retry completes commit-only (never marked sent invisibly)", async () => {
    // First run: writes the file, "commit fails" (simulated by skipping
    // it), exits 0 — the poisoned case the old working-tree check marked
    // sent forever. Second run: file exists → commit-only.
    const command = fakeCommand(
      `mkdir -p "$(dirname "$2")"
if [ ! -e "$2" ]; then
  echo agenda > "$2"
  exit 0
fi
git add -- "$2"
git commit -q --no-verify -m "calendar: agenda for $1" -- "$2"`,
    );
    consent(command);
    const effect = effectFor(command);

    const t0 = new Date("2026-06-10T05:15:00.000Z");
    const first = await dispatchExternalEffect(db, {
      effect,
      runId: "run-1",
      handlers: handlers(),
      now: t0,
    });
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") throw new Error("expected pending");
    expect(first.lastError).toContain("did not commit");
    expect(existsSync(join(vaultPath, OUTPUT_PATH))).toBe(true);
    expect(inHead(OUTPUT_PATH)).toBe(false);

    const second = await dispatchExternalEffect(db, {
      effect,
      runId: "run-2",
      handlers: handlers(),
      now: new Date(new Date(first.nextAttemptAt).getTime() + 1000),
    });
    expect(second.kind).toBe("sent");
    if (second.kind !== "sent") throw new Error("expected sent");
    expect(second.recovered).toBe(false);
    expect(inHead(OUTPUT_PATH)).toBe(true);
  });

  test("a committed-but-unsent row recovers without re-spawning through the real dispatch", async () => {
    mkdirSync(join(vaultPath, "sources", "calendar"), { recursive: true });
    writeFileSync(join(vaultPath, OUTPUT_PATH), "# committed by prior attempt\n");
    git("add", "--", OUTPUT_PATH);
    git("commit", "-q", "--no-verify", "-m", "calendar: agenda", "--", OUTPUT_PATH);
    const command = fakeCommand("echo should-not-run > spawned.txt\nexit 1");
    consent(command);

    const result = await dispatchExternalEffect(db, {
      effect: effectFor(command),
      runId: "run-1",
      handlers: handlers(),
      now: new Date("2026-06-10T05:15:00.000Z"),
    });
    expect(result.kind).toBe("sent");
    if (result.kind !== "sent") throw new Error("expected sent");
    expect(result.recovered).toBe(true);
    expect(existsSync(join(vaultPath, "spawned.txt"))).toBe(false);
  });
});

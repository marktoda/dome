// Phase 9 — end-to-end tests for the four CLI commands.
//
// Each describe block sets up a fresh tmpdir vault (a real git repo
// with two commits), invokes the relevant `run<Command>` function with
// parsed args, and asserts on the returned exit code + the side effects
// on disk / DBs.
//
// Phase 11f: the CLI commands default `--bundles-root` to the SDK's
// shipped `assets/extensions/`. Tests no longer need to copy bundles
// into the tmpdir vault — they just rely on the default resolver. The
// fixture is correspondingly thinner.
//
// Tests run the command handlers directly — they don't spawn `bun`
// subprocesses. That keeps the suite fast and lets us assert on
// internal state (filesystem layout, DB rows) without parsing stdout.
//
// Console output is captured to keep test logs quiet; the assertions
// don't depend on the captured strings (handlers' return codes are the
// load-bearing surface).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../../src/cli/args";
import { runInit } from "../../src/cli/commands/init";
import { runDoctor } from "../../src/cli/commands/doctor";
import { runInspect } from "../../src/cli/commands/inspect";
import { runStatus } from "../../src/cli/commands/status";
import { runSync } from "../../src/cli/commands/sync";
import { resolveShippedBundlesRoot } from "../../src/cli/commands/sync-shared";
import { loadBundles } from "../../src/extensions/loader";

import { commit, currentSha, initRepo, readBlob } from "../../src/git";
import { openProjectionDb } from "../../src/projections/db";
import { queryDiagnostics } from "../../src/projections/diagnostics";

// ----- Console capture ------------------------------------------------------
//
// Each test silences console.log / console.error so the suite output stays
// quiet. The captured strings are exposed via the `captured` object in
// case a test wants to inspect them.

type Captured = {
  out: string[];
  err: string[];
};

let captured: Captured;
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  captured = { out: [], err: [] };
  origLog = console.log;
  origErr = console.error;
  console.log = (...parts: unknown[]) => {
    captured.out.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    captured.err.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

// ----- Fixture helpers -------------------------------------------------------

type Fixture = {
  vaultPath: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a fresh tmpdir vault with two commits. The two commits give
 * submit something to propose (base = first commit, head = second
 * commit). Phase 11f: no bundle copy — the CLI defaults `bundlesRoot`
 * to the SDK's shipped first-party bundles via
 * `resolveShippedBundlesRoot`. The vault path is a fresh tmpdir; the
 * cleanup removes it after the test.
 */
async function makeFixture(): Promise<Fixture> {
  const vaultPath = mkdtempSync(join(tmpdir(), "cli-commands-"));
  await initRepo(vaultPath);
  await mkdir(join(vaultPath, "wiki"), { recursive: true });

  await writeFile(join(vaultPath, "wiki/seed.md"), "seed\n");
  const baseSha = await commit({
    path: vaultPath,
    message: "init\n",
    files: ["wiki/seed.md"],
  });

  await writeFile(join(vaultPath, "wiki/new.md"), "new page\n");
  const headSha = await commit({
    path: vaultPath,
    message: "add wiki/new.md\n",
    files: ["wiki/new.md"],
  });

  // `.dome/state/` is where the engine writes sqlite handles; the runtime
  // creates it on open, but pre-creating mirrors what `dome init` does
  // and keeps the test's setup explicit.
  await mkdir(join(vaultPath, ".dome", "state"), { recursive: true });

  return {
    vaultPath,
    baseSha,
    headSha,
    cleanup: async () => {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

// ----- runInit --------------------------------------------------------------

describe("runInit", () => {
  test("fresh dir → scaffold: dirs, config, orientation files, git+HEAD (no bundle copy)", async () => {
    // Fresh tmpdir — no git repo, no .dome/, no AGENTS.md / CLAUDE.md.
    const target = mkdtempSync(join(tmpdir(), "cli-init-"));
    try {
      const args = parseArgs(["init", target]);
      const code = await runInit(args);
      expect(code).toBe(0);

      // Scaffold dirs. `.dome/extensions/` is NOT created — the shipped
      // first-party bundles live with the SDK, not in the vault.
      expect(existsSync(join(target, "wiki"))).toBe(true);
      expect(existsSync(join(target, ".dome", "state"))).toBe(true);
      expect(existsSync(join(target, ".dome", "extensions"))).toBe(false);

      // No bundle directories under .dome/extensions/.
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.lint")),
      ).toBe(false);
      expect(
        existsSync(join(target, ".dome", "extensions", "dome.markdown")),
      ).toBe(false);

      // config.yaml + orientation files present with expected anchors.
      const configPath = join(target, ".dome", "config.yaml");
      expect(existsSync(configPath)).toBe(true);
      const configBody = await readFile(configPath, "utf8");
      expect(configBody).toContain("dome.graph");
      expect(configBody).toContain("dome.lint");
      expect(configBody).toContain("dome.markdown");
      expect(configBody).toContain("max_iterations");

      const agentsPath = join(target, "AGENTS.md");
      expect(existsSync(agentsPath)).toBe(true);
      const agentsBody = await readFile(agentsPath, "utf8");
      expect(agentsBody).toContain("This is a Dome vault");
      expect(agentsBody).toContain("<!-- BEGIN user-prose -->");
      expect(agentsBody).toContain("<!-- END user-prose -->");

      const claudePath = join(target, "CLAUDE.md");
      expect(existsSync(claudePath)).toBe(true);
      const claudeBody = await readFile(claudePath, "utf8");
      expect(claudeBody.startsWith("@AGENTS.md")).toBe(true);
      expect(claudeBody).toContain("dome status");
      expect(claudeBody).toContain("dome sync");
      expect(claudeBody).toContain("dome inspect <subject>");
      expect(captured.out.join("\n")).toContain("CLAUDE.md:");

      // Git initialized + HEAD resolves (the initial scaffold commit landed).
      expect(existsSync(join(target, ".git"))).toBe(true);
      const head = await currentSha(target);
      expect(head).not.toBeNull();
      if (head !== null) {
        expect(
          await readBlob({ path: target, commit: head, filepath: "AGENTS.md" }),
        ).toBe(agentsBody);
        expect(
          await readBlob({ path: target, commit: head, filepath: "CLAUDE.md" }),
        ).toBe(claudeBody);
      }

      // The SDK-shipped bundles are still loadable from the resolved
      // shipped-bundles root. This is the load-bearing assertion that
      // replaces the dropped per-file bundle-copy checks above.
      const bundlesRoot = resolveShippedBundlesRoot();
      const loaded = await loadBundles({ bundlesRoot });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const ids = loaded.value.map((b) => b.id);
        expect(ids).toContain("dome.graph");
        expect(ids).toContain("dome.lint");
        expect(ids).toContain("dome.markdown");
      }
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test("is idempotent — re-run leaves orientation files byte-identical + no errors", async () => {
    const target = mkdtempSync(join(tmpdir(), "cli-init-idem-"));
    try {
      const args = parseArgs(["init", target]);
      expect(await runInit(args)).toBe(0);

      const agentsPath = join(target, "AGENTS.md");
      const claudePath = join(target, "CLAUDE.md");
      const configPath = join(target, ".dome", "config.yaml");
      const firstAgents = await readFile(agentsPath, "utf8");
      const firstClaude = await readFile(claudePath, "utf8");
      const firstConfig = await readFile(configPath, "utf8");
      const firstHead = await currentSha(target);

      // Mutate the user-prose region and Claude-specific shim notes to
      // confirm `dome init` doesn't clobber post-init edits.
      const mutatedAgents = firstAgents.replace(
        "<!-- BEGIN user-prose -->",
        "<!-- BEGIN user-prose -->\n\nMy private vault notes.",
      );
      const mutatedClaude = `${firstClaude}\nPersonal Claude Code reminder.\n`;
      await writeFile(agentsPath, mutatedAgents, "utf8");
      await writeFile(claudePath, mutatedClaude, "utf8");

      expect(await runInit(args)).toBe(0);

      const secondAgents = await readFile(agentsPath, "utf8");
      const secondClaude = await readFile(claudePath, "utf8");
      const secondConfig = await readFile(configPath, "utf8");
      const secondHead = await currentSha(target);

      // Orientation mutations survive re-init; config untouched; HEAD
      // didn't advance (no second commit landed).
      expect(secondAgents).toBe(mutatedAgents);
      expect(secondClaude).toBe(mutatedClaude);
      expect(secondConfig).toBe(firstConfig);
      expect(secondHead).toBe(firstHead);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  test(
    "end-to-end demo: init → sync init → broken wikilink commit → sync → diagnostic lands",
    async () => {
      const target = mkdtempSync(join(tmpdir(), "cli-init-e2e-"));
      try {
        // Step 1: dome init produces a fully-scaffolded vault with an
        //         initial commit on `main` (HEAD resolves; the adopted
        //         ref is still uninitialized — first `dome sync`
        //         empty-diff-initializes it).
        expect(await runInit(parseArgs(["init", target]))).toBe(0);

        // Phase 11f: `dome sync` defaults `--bundles-root` to the SDK's
        // shipped `assets/extensions/` directory via
        // `resolveShippedBundlesRoot`. The vault doesn't carry any
        // bundle copies; the runtime resolves them at the SDK source.
        // This test runs without `--bundles-root` to exercise the
        // production demo path.

        // Step 2: initialize the adopted ref. Per detectDrift, an
        //         uninitialized adopted ref surfaces as an empty-diff
        //         drift (base === head === HEAD); the engine runs a
        //         no-effect iteration and advances the ref so the next
        //         sync can compute a real diff.
        expect(
          await runSync(parseArgs(["sync", "--vault", target])),
        ).toBe(0);

        // Step 3: user writes a markdown file with a broken wikilink.
        await writeFile(join(target, "wiki", "foo.md"), "[[broken]]\n", "utf8");

        // Step 4: user commits the new file.
        await commit({
          path: target,
          message: "add wiki/foo.md\n",
          files: ["wiki/foo.md"],
        });

        // Step 5: dome sync — this run sees base=initial-scaffold,
        //         head=new-commit, emits `file.created` +
        //         `document.changed` for wiki/foo.md, and
        //         dome.markdown.validate-wikilinks fires.
        expect(
          await runSync(parseArgs(["sync", "--vault", target])),
        ).toBe(0);

        // Step 6: the broken-wikilink diagnostic lands in the projection.
        const projectionPath = join(target, ".dome", "state", "projection.db");
        expect(existsSync(projectionPath)).toBe(true);

        const projectionResult = await openProjectionDb({
          path: projectionPath,
          extensionSet: [
            { name: "dome.lint", version: "0.1.0" },
            { name: "dome.markdown", version: "0.1.0" },
          ],
          processorVersions: [
            { id: "dome.lint.markdown-format", version: "0.1.0" },
            { id: "dome.markdown.validate-wikilinks", version: "0.1.0" },
          ],
        });
        expect(projectionResult.ok).toBe(true);
        if (!projectionResult.ok) return;

        try {
          const diagnostics = queryDiagnostics(projectionResult.value.db);
          const broken = diagnostics.find(
            (d) => d.code === "dome.markdown.broken-wikilink",
          );
          expect(broken).toBeDefined();
          expect(broken?.message).toContain("[[broken]]");
        } finally {
          projectionResult.value.db.close();
        }

        // Step 7: the broken-wikilink must also appear in the user-facing
        // CLI output. Regression: before queryDiagnostics ordered DESC, a
        // user with N>20 accumulated diagnostics couldn't see freshly-
        // emitted ones in `dome inspect diagnostics`'s default view. The
        // DB had the row; the CLI didn't surface it. This step is the
        // structural fence against that class of UX bug: we assert the
        // freshest diagnostic appears in the CLI's default-limit output.
        captured.out = [];
        captured.err = [];
        const inspectCode = await runInspect(
          parseArgs(["inspect", "diagnostics", "--vault", target]),
        );
        expect(inspectCode).toBe(0);
        const inspectOut = captured.out.join("\n");
        expect(inspectOut).toContain("[[broken]]");
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    },
    // The end-to-end test spins up two full adoption runs (the
    // empty-diff init + the wiki/foo.md drift) and opens four sqlite
    // handles across the engine + the test's direct projection read.
    // 30s is comfortably above the observed runtime on CI.
    30_000,
  );
});

// ----- runInspect -----------------------------------------------------------
//
// `dome inspect <subject>` is the v1.0 read surface for the operational
// substrate (renamed from the pre-recut `dome doctor --show <subject>`
// shape per [[wiki/specs/cli]] §"dome inspect"). Subject is positional,
// not a flag; v1.0 ships four subjects (runs, diagnostics, questions,
// outbox), each backed by an existing query function.

describe("runInspect", () => {
  test("subject 'runs' returns 0 on a fresh vault with an empty-table message", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["inspect", "runs", "--vault", f.vaultPath]);
    const code = await runInspect(args);
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("(no rows)");
  });

  test("subject 'diagnostics' returns 0 on a fresh vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["inspect", "diagnostics", "--vault", f.vaultPath]);
    expect(await runInspect(args)).toBe(0);
  });

  test("subjects 'questions' and 'outbox' both return 0", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect(
        parseArgs(["inspect", "questions", "--vault", f.vaultPath]),
      ),
    ).toBe(0);
    expect(
      await runInspect(
        parseArgs(["inspect", "outbox", "--vault", f.vaultPath]),
      ),
    ).toBe(0);
  });

  test("corrupt operational JSON returns a clear state-read failure", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    expect(
      await runInspect(
        parseArgs(["inspect", "outbox", "--vault", f.vaultPath]),
      ),
    ).toBe(0);
    const db = new Database(join(f.vaultPath, ".dome", "state", "outbox.db"));
    try {
      const now = new Date().toISOString();
      db.query(
        "INSERT INTO outbox (capability, idempotency_key, payload_json, source_refs, status, attempts, max_attempts, enqueued_at, next_attempt_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "calendar.write",
        "bad-json",
        "{not-json",
        "[]",
        "pending",
        0,
        3,
        now,
        now,
        "run_bad_json",
      );
    } finally {
      db.close();
    }

    const code = await runInspect(
      parseArgs(["inspect", "outbox", "--vault", f.vaultPath]),
    );
    expect(code).toBe(1);
    expect(captured.err.join("\n")).toContain("state read failed");
    expect(captured.err.join("\n")).toContain(
      "operational database may be corrupt",
    );
  });

  test("missing positional subject returns 64 (EX_USAGE)", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["inspect", "--vault", f.vaultPath]);
    expect(await runInspect(args)).toBe(64);
  });

  test("unknown subject returns 64", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["inspect", "garbage", "--vault", f.vaultPath]);
    expect(await runInspect(args)).toBe(64);
  });
});

// ----- runDoctor (v1.0 stub) ------------------------------------------------
//
// `dome doctor` is reserved for the v1.x health-check verb per
// [[wiki/specs/cli]] §"dome doctor". v1.0 ships a stub that prints the
// reserved-for-v1.x notice; `--repair` exits 64 (not implemented).

describe("runDoctor (v1.0 stub)", () => {
  test("without flags: exits 0 with the reserved-for-v1.x notice", async () => {
    const code = await runDoctor(parseArgs(["doctor"]));
    expect(code).toBe(0);
    expect(captured.out.join("\n")).toContain("reserved for v1.x");
  });

  test("with --repair: exits 64 (not implemented in v1.0)", async () => {
    const code = await runDoctor(parseArgs(["doctor", "--repair"]));
    expect(code).toBe(64);
    expect(captured.err.join("\n")).toContain("not implemented in v1.0");
  });
});

// ----- runStatus ------------------------------------------------------------

describe("runStatus", () => {
  test("prints sensible defaults on a fresh (unsubmitted) vault", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["status", "--vault", f.vaultPath]);
    const code = await runStatus(args);
    expect(code).toBe(0);

    const out = captured.out.join("\n");
    expect(out).toContain("(uninitialized)"); // adopted ref
    expect(out).toContain("(never)"); // last_sync
  });

  test("--json mode emits a parseable JSON object with expected keys", async () => {
    const f = await makeFixture();
    fixtures.push(f);

    const args = parseArgs(["status", "--vault", f.vaultPath, "--json"]);
    expect(await runStatus(args)).toBe(0);

    const blob = captured.out.find((l) => l.includes("\"vault\""));
    expect(blob).toBeDefined();
    if (blob === undefined) return;
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    expect(parsed["vault"]).toBe(f.vaultPath);
    expect(parsed["branch"]).toBeDefined();
    expect(parsed["pending_runs"]).toBe(0);
  });

  // The "status after a submit reports the advanced adopted ref" test
  // was retired in Phase 11a along with `runSubmit`; the corresponding
  // assertion against an advanced adopted ref will land in the Phase 11b
  // daemon integration tests, which drive adoption via the watcher.
});

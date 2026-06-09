// Wedge Phase 3 — tests for `dome capture`.
//
// Per docs/wiki/specs/cli.md §"dome capture" + docs/wiki/specs/capture.md,
// the command writes a timestamped raw capture into `inbox/raw/`, commits
// exactly that one file on the current branch as an ordinary HUMAN commit
// (no Dome-* trailers), and returns immediately. The testability contract:
// the clock and the stdin boundary are injected, so every test runs against
// a temp vault with deterministic paths and no real stdin.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureSlug,
  captureTimestampSegment,
  deriveCaptureTitle,
  normalizeCaptureTitle,
  renderCaptureDocument,
  runCapture,
  type CaptureStdin,
} from "../../src/cli/commands/capture";
import { runInit } from "../../src/cli/commands/init";
import { add, log, readBlob, resolveRef, statusMatrix } from "../../src/git";

// ----- Console capture ------------------------------------------------------

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map((p) => String(p)).join(" "));
  };
});

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ----- Fixtures ---------------------------------------------------------------

let tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Initialized Dome vault (git repo + scaffold commit + .dome/config.yaml). */
async function initVault(): Promise<string> {
  const vault = tempDir("dome-capture-vault-");
  expect(await runInit({ path: vault })).toBe(0);
  logs = [];
  errors = [];
  return vault;
}

/** A fixed capture moment so target paths are deterministic. */
const NOW = new Date(2026, 5, 9, 23, 11, 0); // local 2026-06-09 23:11
const STAMP = captureTimestampSegment(NOW);
const clock = { now: () => NOW };

function pipedStdin(content: string): CaptureStdin {
  return { isTTY: false, readToEnd: async () => content };
}

const ttyStdin: CaptureStdin = {
  isTTY: true,
  readToEnd: async () => {
    throw new Error("must not read a TTY stdin");
  },
};

async function headCommit(vault: string) {
  const entries = await log({ path: vault, depth: 1 });
  const head = entries[0];
  if (head === undefined) throw new Error("no commits");
  return head;
}

// ----- Pure helpers -----------------------------------------------------------

describe("capture helpers", () => {
  test("captureTimestampSegment renders local YYYY-MM-DD-HHmm", () => {
    expect(captureTimestampSegment(new Date(2026, 0, 5, 7, 3))).toBe(
      "2026-01-05-0703",
    );
  });

  test("captureSlug kebab-cases, bounds words, and falls back to 'capture'", () => {
    expect(captureSlug("Call the landlord about the radiator TODAY ok")).toBe(
      "call-the-landlord-about-the-radiator",
    );
    expect(captureSlug("Crème brûlée — déjà vu!")).toBe(
      "creme-brulee-deja-vu",
    );
    expect(captureSlug("!!! ???")).toBe("capture");
    expect(captureSlug(null)).toBe("capture");
    expect(
      captureSlug(
        "supercalifragilisticexpialidocious antidisestablishmentarianism words",
      ).length,
    ).toBeLessThanOrEqual(48);
  });

  test("deriveCaptureTitle takes the first meaningful line, skipping frontmatter and # markers", () => {
    expect(deriveCaptureTitle("# A heading\n\nbody")).toBe("A heading");
    expect(deriveCaptureTitle("\n\n  plain thought  \n")).toBe("plain thought");
    expect(
      deriveCaptureTitle("---\ntitle: pre-existing\n---\n\nreal first line\n"),
    ).toBe("real first line");
    expect(deriveCaptureTitle("   \n\n")).toBe(null);
    expect(deriveCaptureTitle(`${"x".repeat(120)}`)?.length).toBe(80);
  });

  test("normalizeCaptureTitle collapses whitespace and caps like derived titles", () => {
    expect(normalizeCaptureTitle("plain title")).toBe("plain title");
    expect(normalizeCaptureTitle("line one\nDome-Run: fake\ttabs")).toBe(
      "line one Dome-Run: fake tabs",
    );
    expect(normalizeCaptureTitle("  \n \t ")).toBe(null);
    expect(normalizeCaptureTitle("x".repeat(120))?.length).toBe(80);
  });

  test("renderCaptureDocument writes the documented raw-capture shape", () => {
    const doc = renderCaptureDocument({
      capturedAt: "2026-06-10T06:11:00.000Z",
      title: 'a "quoted" title',
      body: "  the thought  \n",
    });
    expect(doc).toBe(
      [
        "---",
        "captured: 2026-06-10T06:11:00.000Z",
        "source: cli",
        'title: "a \\"quoted\\" title"',
        "---",
        "",
        "the thought",
        "",
      ].join("\n"),
    );
    // No explicit title → no title: row, and no type: field ever.
    const bare = renderCaptureDocument({
      capturedAt: "2026-06-10T06:11:00.000Z",
      body: "x",
    });
    expect(bare).not.toContain("title:");
    expect(bare).not.toContain("type:");
  });
});

// ----- runCapture: inputs -------------------------------------------------------

describe("runCapture inputs", () => {
  test("positional text writes inbox/raw/<stamp>-<slug>.md with frontmatter and commits it", async () => {
    const vault = await initVault();
    const code = await runCapture(
      { vault, text: "call the landlord about the radiator before friday" },
      clock,
    );
    expect(code).toBe(0);

    const relPath = `inbox/raw/${STAMP}-call-the-landlord-about-the-radiator.md`;
    const absPath = join(vault, relPath);
    expect(existsSync(absPath)).toBe(true);

    const content = await readFile(absPath, "utf8");
    expect(content).toStartWith("---\n");
    expect(content).toContain(`captured: ${NOW.toISOString()}`);
    expect(content).toContain("source: cli");
    expect(content).not.toContain("title:"); // no explicit --title
    expect(content).toContain(
      "call the landlord about the radiator before friday",
    );

    // Human commit on the current branch: capture message, no Dome trailers.
    const head = await headCommit(vault);
    expect(head.commit.message).toStartWith(
      "capture: call the landlord about the radiator before friday",
    );
    expect(head.commit.message).not.toContain("Dome-Run:");
    expect(head.commit.message).not.toContain("Dome-Base:");
    expect(head.commit.author.name).toBe("dome capture");
    expect(await resolveRef({ path: vault, ref: "refs/heads/main" })).toBe(
      head.oid,
    );

    // The capture file is in the committed tree and the tree is clean.
    expect(await readBlob({ path: vault, commit: head.oid, filepath: relPath }))
      .toBe(content);
    const dirty = (await statusMatrix(vault)).filter(
      ([, headState, workdir, stage]) => !(headState === 1 && workdir === 1 && stage === 1),
    );
    expect(dirty).toEqual([]);

    // Text output: path + status-aware pending hint (no serve host, no adopted ref).
    const out = logs.join("\n");
    expect(out).toContain(relPath);
    expect(out).toContain("compile pending");
  });

  test("stdin is read when no argument or --file is given", async () => {
    const vault = await initVault();
    const code = await runCapture({ vault }, {
      ...clock,
      stdin: pipedStdin("an idea from a pipe\n"),
    });
    expect(code).toBe(0);
    const relPath = `inbox/raw/${STAMP}-an-idea-from-a-pipe.md`;
    expect(await readFile(join(vault, relPath), "utf8")).toContain(
      "an idea from a pipe",
    );
  });

  test("--file reads the capture body from any path", async () => {
    const vault = await initVault();
    const source = join(tempDir("dome-capture-src-"), "memo.txt");
    await writeFile(source, "transcribed voice memo about Q3\n", "utf8");

    const code = await runCapture({ vault, file: source }, clock);
    expect(code).toBe(0);
    const relPath = `inbox/raw/${STAMP}-transcribed-voice-memo-about-q3.md`;
    expect(await readFile(join(vault, relPath), "utf8")).toContain(
      "transcribed voice memo about Q3",
    );
  });

  test("--title drives the slug, the frontmatter, and the commit message", async () => {
    const vault = await initVault();
    const code = await runCapture(
      { vault, text: "long rambling body text here", title: "Landlord call" },
      clock,
    );
    expect(code).toBe(0);
    const relPath = `inbox/raw/${STAMP}-landlord-call.md`;
    const content = await readFile(join(vault, relPath), "utf8");
    expect(content).toContain('title: "Landlord call"');
    expect((await headCommit(vault)).commit.message).toStartWith(
      "capture: Landlord call",
    );
  });

  test("a newline-containing --title cannot inject trailer-shaped lines into the commit message", async () => {
    // Engine commits are recognized by Dome-* trailer lines; an unsanitized
    // explicit title could fabricate them. Explicit titles get the same
    // single-line + 80-char normalization as derived ones.
    const vault = await initVault();
    const code = await runCapture(
      {
        vault,
        text: "body",
        title: "innocent\nDome-Run: forged-run-id\nDome-Base: forged",
      },
      clock,
    );
    expect(code).toBe(0);

    const message = (await headCommit(vault)).commit.message;
    const [subject, ...rest] = message.split("\n");
    expect(subject).toBe(
      "capture: innocent Dome-Run: forged-run-id Dome-Base: forged",
    );
    expect(rest.join("\n")).not.toContain("Dome-");

    // The frontmatter carries the normalized title too.
    const relPath = `inbox/raw/${STAMP}-innocent-dome-run-forged-run-id.md`;
    const content = await readFile(join(vault, relPath), "utf8");
    expect(content).toContain(
      'title: "innocent Dome-Run: forged-run-id Dome-Base: forged"',
    );
  });

  test("an over-long explicit --title is capped at 80 chars like derived titles", async () => {
    const vault = await initVault();
    const code = await runCapture(
      { vault, text: "body", title: `${"t".repeat(200)}` },
      clock,
    );
    expect(code).toBe(0);
    const message = (await headCommit(vault)).commit.message;
    expect(message.split("\n")[0]).toBe(`capture: ${"t".repeat(80)}`);
  });

  test("collisions disambiguate deterministically with -2, -3 suffixes", async () => {
    const vault = await initVault();
    for (let i = 0; i < 3; i += 1) {
      expect(await runCapture({ vault, text: "same idea" }, clock)).toBe(0);
    }
    const base = `inbox/raw/${STAMP}-same-idea`;
    expect(existsSync(join(vault, `${base}.md`))).toBe(true);
    expect(existsSync(join(vault, `${base}-2.md`))).toBe(true);
    expect(existsSync(join(vault, `${base}-3.md`))).toBe(true);
  });
});

// ----- runCapture: the one-file commit contract ----------------------------------

describe("runCapture commit isolation", () => {
  test("dirty and staged working-tree changes are not swept into the capture commit", async () => {
    const vault = await initVault();

    // Staged-but-uncommitted edit to a tracked file...
    const agentsOriginal = await readFile(join(vault, "AGENTS.md"), "utf8");
    await writeFile(join(vault, "AGENTS.md"), `${agentsOriginal}\nSTAGED EDIT\n`);
    await add(vault, "AGENTS.md");
    // ...plus an untracked draft.
    await writeFile(join(vault, "notes/draft.md"), "loose draft\n", "utf8");

    expect(await runCapture({ vault, text: "the capture" }, clock)).toBe(0);

    const head = await headCommit(vault);
    // The capture commit carries the capture file...
    expect(
      await readBlob({
        path: vault,
        commit: head.oid,
        filepath: `inbox/raw/${STAMP}-the-capture.md`,
      }),
    ).toContain("the capture");
    // ...but NOT the staged AGENTS.md edit and NOT the untracked draft.
    expect(
      await readBlob({ path: vault, commit: head.oid, filepath: "AGENTS.md" }),
    ).toBe(agentsOriginal);
    expect(
      await readBlob({ path: vault, commit: head.oid, filepath: "notes/draft.md" }),
    ).toBe(null);

    // The staged edit is still staged and the draft is still untracked.
    const matrix = await statusMatrix(vault);
    const agentsRow = matrix.find(([filepath]) => filepath === "AGENTS.md");
    expect(agentsRow).toEqual(["AGENTS.md", 1, 2, 2]); // modified + staged
    const draftRow = matrix.find(([filepath]) => filepath === "notes/draft.md");
    expect(draftRow).toEqual(["notes/draft.md", 0, 2, 0]); // untracked
  });
});

// ----- runCapture: errors ---------------------------------------------------------

describe("runCapture errors", () => {
  test("empty input is a usage error and writes nothing", async () => {
    const vault = await initVault();
    const before = (await headCommit(vault)).oid;
    expect(await runCapture({ vault, text: "   \n " }, clock)).toBe(64);
    expect(errors.join("\n")).toContain("empty capture");
    expect((await headCommit(vault)).oid).toBe(before);
    expect(existsSync(join(vault, `inbox/raw/${STAMP}-capture.md`))).toBe(false);
  });

  test("positional text combined with --file is a usage error", async () => {
    const vault = await initVault();
    expect(
      await runCapture({ vault, text: "x", file: "/tmp/whatever" }, clock),
    ).toBe(64);
    expect(errors.join("\n")).toContain("not both");
  });

  test("an interactive TTY with no input is a usage error, not a hang", async () => {
    const vault = await initVault();
    expect(await runCapture({ vault }, { ...clock, stdin: ttyStdin })).toBe(64);
    expect(errors.join("\n")).toContain("no input");
  });

  test("an unreadable --file path exits 1", async () => {
    const vault = await initVault();
    expect(
      await runCapture({ vault, file: join(vault, "missing.txt") }, clock),
    ).toBe(1);
    expect(errors.join("\n")).toContain("cannot read --file");
  });

  test("a directory that is not a git repo is refused with a dome init pointer", async () => {
    const dir = tempDir("dome-capture-nogit-");
    expect(await runCapture({ vault: dir, text: "x" }, clock)).toBe(64);
    expect(errors.join("\n")).toContain("not an initialized Dome vault");
    expect(errors.join("\n")).toContain("dome init");
  });

  test("a git repo without .dome/config.yaml is refused", async () => {
    const dir = tempDir("dome-capture-noconfig-");
    const { initRepo } = await import("../../src/git");
    await initRepo(dir);
    expect(await runCapture({ vault: dir, text: "x" }, clock)).toBe(64);
    expect(errors.join("\n")).toContain(".dome/config.yaml");
  });

  test("a config-present vault with zero commits is refused with a dome init pointer", async () => {
    // The adopted-ref substrate needs HEAD to resolve; capture refuses
    // before writing anything (capture.ts vault-precondition block).
    const dir = tempDir("dome-capture-nocommits-");
    const { initRepo } = await import("../../src/git");
    await initRepo(dir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".dome"), { recursive: true });
    await writeFile(join(dir, ".dome", "config.yaml"), "extensions: {}\n", "utf8");

    expect(await runCapture({ vault: dir, text: "x" }, clock)).toBe(64);
    expect(errors.join("\n")).toContain("no commits yet");
    expect(errors.join("\n")).toContain("dome init");
    expect(existsSync(join(dir, "inbox"))).toBe(false);
  });

  test("a detached HEAD is refused — the capture loop needs a branch", async () => {
    const vault = await initVault();
    const head = (await headCommit(vault)).oid;
    // Detach HEAD by pointing it directly at the commit OID.
    await writeFile(join(vault, ".git", "HEAD"), `${head}\n`, "utf8");

    expect(await runCapture({ vault, text: "x" }, clock)).toBe(64);
    expect(errors.join("\n")).toContain("detached HEAD");
    // Nothing was committed: HEAD still resolves to the same commit.
    expect((await headCommit(vault)).oid).toBe(head);
  });

  test("error cases emit the dome.capture/v1 error payload under --json", async () => {
    const dir = tempDir("dome-capture-jsonerr-");
    expect(await runCapture({ vault: dir, text: "x", json: true }, clock)).toBe(64);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.capture/v1");
    expect(payload.status).toBe("error");
    expect(payload.error).toContain("not an initialized Dome vault");
  });
});

// ----- runCapture: --json -----------------------------------------------------------

describe("runCapture --json", () => {
  test("emits the dome.capture/v1 payload with status-aware compile_pending", async () => {
    const vault = await initVault();
    const code = await runCapture(
      { vault, text: "json capture", json: true },
      clock,
    );
    expect(code).toBe(0);

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.capture/v1");
    expect(payload.status).toBe("captured");
    expect(payload.vault).toBe(vault);
    expect(payload.path).toBe(`inbox/raw/${STAMP}-json-capture.md`);
    expect(payload.title).toBe("json capture");
    expect(payload.captured_at).toBe(NOW.toISOString());
    expect(payload.source).toBe("cli");
    expect(payload.branch).toBe("main");
    expect(payload.commit).toBe((await headCommit(vault)).oid);
    // Fresh vault: no serve heartbeat, no adopted ref → compile pending.
    expect(payload.serve_status).toBe("off");
    expect(payload.adopted_initialized).toBe(false);
    expect(payload.compile_pending).toBe(true);
  });
});

// cli/commands/capture: `dome capture` — Phase 3 of the product wedge
// (docs/wedge.md §"Phase 3 — Capture loop").
//
// Per docs/wiki/specs/cli.md §"dome capture" + docs/wiki/specs/capture.md,
// this is the frictionless ingress command: take a thought from an argument,
// a file, or stdin; write it as a timestamped raw capture under `inbox/raw/`;
// commit exactly that one file on the current branch; return immediately.
// Everything after the commit boundary is the existing capture loop (the
// compiler host adopts, `dome.agent.ingest` integrates, the stale-check
// warns) — capture never talks to the engine.
//
// Design constraints carried from the spec:
//
//   - The commit is a HUMAN write: ordinary message `capture: <title>`, no
//     Dome-* trailers. The daemon constructs the Proposal from branch drift
//     like any other human commit (PROPOSALS_ARE_THE_ONLY_WRITE_PATH).
//   - Exactly one path changes in the commit. A dirty working tree —
//     including already-staged-but-uncommitted changes — must not be swept
//     in, so the commit is built via `commitSingleFileOnHead` (HEAD tree +
//     one spliced blob) rather than an index commit.
//   - The filename carries the capture moment in LOCAL time
//     (`YYYY-MM-DD-HHmm`) so an 11pm thought files under that evening;
//     frontmatter `captured:` carries the same instant as ISO-8601 UTC.
//   - Collisions disambiguate deterministically with `-2`, `-3`, … suffixes.
//   - The next-step hint is status-aware using only cheap reads: the serve
//     heartbeat file and `refs/dome/adopted/<branch>`. No runtime is opened.
//
// Mutation-boundary note: like `src/cli/commands/init.ts`, this is the
// human-side write path at the compiler boundary — a text editor + `git
// commit` in one verb — not an engine write path. The file is whitelisted in
// `tests/integration/no-direct-mutation-outside-boundaries.test.ts`
// `ALLOWED_FILES`, matching init.ts / install.ts.
//
// House-style notes (matches src/cli/commands/install.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher calls
//     `process.exit(code)`.
//   - Testability via an injected deps object (clock + stdin boundary).

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { getAdoptedRef } from "../../adopted-ref";
import {
  readServeHeartbeatStatus,
} from "../../engine/host/compiler-host-heartbeat";
import {
  commitSingleFileOnHead,
  currentBranch,
  currentSha,
  findGitRoot,
} from "../../git";
import { formatJson } from "../format";
import {
  bullets,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
  type KvRow,
  type Status,
} from "../presenter";

import { resolveVaultPath } from "../resolve-vault";
// ----- Constants ------------------------------------------------------------

const EX_USAGE = 64;

const RAW_INBOX_DIR = "inbox/raw";

/** Slug length cap, per the spec ("capped at 48 chars"). */
const SLUG_MAX_CHARS = 48;

/** Slug word budget, per the spec ("up to six words"). */
const SLUG_MAX_WORDS = 6;

/** Display-title length cap for commit messages and JSON. */
const TITLE_MAX_CHARS = 80;

// ----- Public types ---------------------------------------------------------

export type RunCaptureOptions = {
  readonly text?: string | undefined;
  readonly file?: string | undefined;
  readonly title?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

/**
 * `performCapture` options — the CLI option set plus the remote-capture-seam
 * fields ([[wiki/specs/capture]] §"The remote-capture seam"): `source` is the
 * honest ingress channel written into frontmatter (default `cli`), and
 * `captureId` is the client-supplied retry-idempotency key that drives the
 * filename slug.
 */
export type PerformCaptureOptions = Omit<RunCaptureOptions, "json"> & {
  readonly source?: string | undefined;
  readonly captureId?: string | undefined;
};

/** The successful capture, before any rendering. */
export type CaptureSuccess = {
  readonly vault: string;
  readonly path: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly source: string;
  readonly branch: string;
  readonly commit: string;
  readonly serveStatus: "running" | "stale" | "off";
  readonly adoptedInitialized: boolean;
  readonly compilePending: boolean;
};

/**
 * The data-returning outcome of one capture attempt. `runCapture` renders
 * it for the terminal; the MCP `capture` tool and the HTTP surface render
 * it as the same `dome.capture/v1` document via `captureJsonDocument`.
 * `duplicate` is the seam's retry answer: a file for this `captureId`
 * already exists, nothing was written or committed.
 */
export type CaptureOutcome =
  | { readonly kind: "captured"; readonly result: CaptureSuccess }
  | {
      readonly kind: "duplicate";
      readonly vault: string;
      readonly path: string;
      readonly captureId: string;
    }
  | {
      readonly kind: "error";
      readonly exitCode: number;
      readonly vault: string;
      readonly error: string;
    };

/**
 * Render a `CaptureOutcome` as the `dome.capture/v1` JSON document — the
 * single shape both `dome capture --json` and the MCP `capture` tool emit.
 */
export function captureJsonDocument(
  outcome: CaptureOutcome,
): Record<string, unknown> {
  if (outcome.kind === "error") {
    return {
      schema: "dome.capture/v1",
      status: "error",
      vault: outcome.vault,
      error: outcome.error,
    };
  }
  if (outcome.kind === "duplicate") {
    return {
      schema: "dome.capture/v1",
      status: "duplicate",
      vault: outcome.vault,
      path: outcome.path,
      capture_id: outcome.captureId,
    };
  }
  const r = outcome.result;
  return {
    schema: "dome.capture/v1",
    status: "captured",
    vault: r.vault,
    path: r.path,
    title: r.title,
    captured_at: r.capturedAt,
    source: r.source,
    branch: r.branch,
    commit: r.commit,
    serve_status: r.serveStatus,
    adopted_initialized: r.adoptedInitialized,
    compile_pending: r.compilePending,
  };
}

/**
 * The stdin boundary. The default reads the real process stdin; tests inject
 * a fake so piped-input and TTY-refusal behavior is hermetic.
 */
export type CaptureStdin = {
  readonly isTTY: boolean;
  readonly readToEnd: () => Promise<string>;
};

/**
 * Injectable host boundaries for `runCapture`. `now` drives both the
 * filename timestamp (local time) and the `captured:` frontmatter instant
 * (UTC); tests inject a fixed clock for deterministic paths.
 */
export type CaptureDeps = {
  readonly now?: (() => Date) | undefined;
  readonly stdin?: CaptureStdin | undefined;
};

// ----- Pure helpers (exported for tests) -------------------------------------

/**
 * Derive a display title from capture content: the first non-empty line,
 * skipping a leading frontmatter block and `#` heading markers, truncated to
 * a commit-message-friendly length. Returns null when nothing survives.
 */
export function deriveCaptureTitle(content: string): string | null {
  const body = stripLeadingFrontmatter(content);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/^#+\s*/, "").trim();
    if (line.length === 0) continue;
    return line.length > TITLE_MAX_CHARS
      ? line.slice(0, TITLE_MAX_CHARS).trimEnd()
      : line;
  }
  return null;
}

/**
 * Normalize an explicit `--title` the same way derived titles are bounded:
 * whitespace runs (including newlines) collapse to single spaces, then the
 * single line is capped at the display length. Without the collapse, a
 * newline-containing title would inject extra lines into the `capture:
 * <title>` commit message — including lines shaped like `Dome-*` trailers,
 * which engine commits use as an authenticity signal. Returns null when
 * nothing survives (caller falls back to the derived title).
 */
export function normalizeCaptureTitle(raw: string): string | null {
  const line = raw.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > TITLE_MAX_CHARS
    ? line.slice(0, TITLE_MAX_CHARS).trimEnd()
    : line;
}

/**
 * Kebab-case slug from a title: up to six words, lowercased, diacritics
 * stripped, non-`[a-z0-9]` runs collapsed to `-`, capped at 48 chars.
 * Falls back to `capture` when nothing survives sanitization.
 */
export function captureSlug(title: string | null): string {
  if (title === null) return "capture";
  const words = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0)
    .slice(0, SLUG_MAX_WORDS);
  const slug = words.join("-").slice(0, SLUG_MAX_CHARS).replace(/-+$/, "");
  return slug.length > 0 ? slug : "capture";
}

/**
 * The filename timestamp segment: the capture moment in LOCAL time as
 * `YYYY-MM-DD-HHmm`. Local, not UTC — captures are human moments, and an
 * 11pm thought should file under that evening's date.
 */
export function captureTimestampSegment(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return [
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `-${pad(now.getHours())}${pad(now.getMinutes())}`,
  ].join("");
}

/**
 * Render the raw-capture document per docs/wiki/specs/capture.md §"Raw
 * capture file shape": `captured:` (ISO-8601 UTC) + `source: cli` (+
 * `title:` when explicitly supplied), then the body trimmed of surrounding
 * whitespace. No `type:` field — inbox/ roots are untyped and the file is
 * ephemeral.
 */
export function renderCaptureDocument(input: {
  readonly capturedAt: string;
  readonly title?: string | undefined;
  readonly body: string;
  readonly source?: string | undefined;
}): string {
  const lines = [
    "---",
    `captured: ${input.capturedAt}`,
    `source: ${input.source ?? "cli"}`,
  ];
  if (input.title !== undefined) {
    lines.push(`title: ${JSON.stringify(input.title)}`);
  }
  lines.push("---", "", input.body.trim(), "");
  return lines.join("\n");
}

// ----- runCapture -----------------------------------------------------------

/**
 * Perform one capture: resolve input, validate vault preconditions, write
 * the raw-capture file, and commit exactly that one file on the current
 * branch. Data-returning and print-free — `runCapture` and the MCP
 * `capture` tool both render the returned outcome. Never opens the runtime.
 */
export async function performCapture(
  options: PerformCaptureOptions = {},
  deps: CaptureDeps = {},
): Promise<CaptureOutcome> {
  const vaultPath = resolveVaultPath(options.vault);
  const now = (deps.now ?? (() => new Date()))();
  const failWith = (exitCode: number, error: string): CaptureOutcome =>
    Object.freeze({ kind: "error" as const, exitCode, vault: vaultPath, error });

  // The honest ingress channel ([[wiki/specs/capture]] §"Raw capture file
  // shape"). Constrained to a single conservative token so a caller-supplied
  // channel can never splice frontmatter lines.
  const source = options.source ?? "cli";
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(source)) {
    return failWith(
      EX_USAGE,
      `invalid source channel '${source}': expected 1-32 chars of [a-z0-9_-]`,
    );
  }

  // --- Input resolution (argument > --file > stdin) -------------------------
  if (options.text !== undefined && options.file !== undefined) {
    return failWith(
      EX_USAGE,
      "pass capture text either as an argument or via --file, not both",
    );
  }

  let body: string;
  if (options.text !== undefined) {
    body = options.text;
  } else if (options.file !== undefined) {
    try {
      body = await readFile(resolve(options.file), "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return failWith(1, `cannot read --file ${options.file}: ${msg}`);
    }
  } else {
    const stdin = deps.stdin ?? realStdin();
    if (stdin.isTTY) {
      return failWith(
        EX_USAGE,
        "no input: pass capture text, use --file <path>, or pipe stdin",
      );
    }
    body = await stdin.readToEnd();
  }

  if (body.trim().length === 0) {
    return failWith(EX_USAGE, "empty capture: nothing to write");
  }

  // --- Vault preconditions ---------------------------------------------------
  const gitRoot = await findGitRoot(vaultPath);
  if (gitRoot === null || !existsSync(join(vaultPath, ".dome", "config.yaml"))) {
    return failWith(
      EX_USAGE,
      `not an initialized Dome vault (missing ${
        gitRoot === null ? "git repository" : ".dome/config.yaml"
      }); run \`dome init\` first`,
    );
  }
  if ((await currentSha(vaultPath)) === null) {
    return failWith(
      EX_USAGE,
      "the vault has no commits yet; run `dome init` first",
    );
  }
  const branch = await currentBranch(vaultPath);
  if (branch === null) {
    return failWith(
      EX_USAGE,
      "detached HEAD: the capture loop needs a branch; check out a branch first",
    );
  }

  // --- Write + commit ----------------------------------------------------------
  try {
    const explicitTitle =
      options.title === undefined ? null : normalizeCaptureTitle(options.title);
    const derivedTitle = explicitTitle === null ? deriveCaptureTitle(body) : null;
    const title = explicitTitle ?? derivedTitle ?? "capture";

    // With a captureId, the id drives the slug and retries are idempotent:
    // an existing file for the same id answers `duplicate` — nothing is
    // written or committed ([[wiki/specs/capture]] §"Retry semantics").
    const captureId = options.captureId;
    const slug =
      captureId !== undefined
        ? captureSlug(captureId)
        : captureSlug(explicitTitle ?? derivedTitle);
    if (captureId !== undefined) {
      const existing = findCaptureBySlug(vaultPath, slug);
      if (existing !== null) {
        return Object.freeze({
          kind: "duplicate" as const,
          vault: vaultPath,
          path: existing,
          captureId,
        });
      }
    }

    const relPath = resolveTargetPath(
      vaultPath,
      captureTimestampSegment(now),
      slug,
    );
    const capturedAt = now.toISOString();
    const document = renderCaptureDocument({
      capturedAt,
      ...(explicitTitle !== null ? { title: explicitTitle } : {}),
      body,
      source,
    });

    await mkdir(join(vaultPath, RAW_INBOX_DIR), { recursive: true });
    await writeFile(join(vaultPath, relPath), document, "utf8");

    // Ordinary human commit: `capture: <title>`, no Dome-* trailers. Built
    // against the HEAD tree plus this one blob so nothing else — staged or
    // dirty — rides along.
    const commitOid = await commitSingleFileOnHead({
      path: vaultPath,
      filepath: relPath,
      content: document,
      message: `capture: ${title}`,
      author: { name: "dome capture", email: "dome-capture@local" },
    });

    // Cheap status reads only (heartbeat file + adopted ref) — capture must
    // return immediately and never open the runtime.
    const heartbeat = await readServeHeartbeatStatus({ vaultPath, now });
    const adoptedInitialized = (await getAdoptedRef(vaultPath, branch)) !== null;
    const compilePending =
      heartbeat.status !== "running" || !adoptedInitialized;

    return Object.freeze({
      kind: "captured" as const,
      result: Object.freeze({
        vault: vaultPath,
        path: relPath,
        title,
        capturedAt,
        source,
        branch,
        commit: commitOid,
        serveStatus: heartbeat.status,
        adoptedInitialized,
        compilePending,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failWith(1, `failed: ${msg}`);
  }
}

/**
 * Execute `dome capture`. Returns the exit code: 0 on success; 64 (EX_USAGE)
 * on empty input, text+`--file` conflict, TTY-with-no-input, uninitialized
 * vault, no commits, or detached HEAD; 1 on an unreadable `--file` path or
 * unexpected I/O failure.
 */
export async function runCapture(
  options: RunCaptureOptions = {},
  deps: CaptureDeps = {},
): Promise<number> {
  const json = options.json === true;
  const outcome = await performCapture(
    {
      text: options.text,
      file: options.file,
      title: options.title,
      vault: options.vault,
    },
    deps,
  );

  if (outcome.kind === "error") {
    if (json) {
      console.log(formatJson(captureJsonDocument(outcome)));
    } else {
      console.error(`dome capture: ${outcome.error}`);
    }
    return outcome.exitCode;
  }
  if (outcome.kind === "duplicate") {
    // Unreachable from CLI flags today (no --capture-id option); handled for
    // exhaustiveness so a future flag cannot silently fall through.
    if (json) {
      console.log(formatJson(captureJsonDocument(outcome)));
    } else {
      console.log(`dome capture: duplicate of ${outcome.path}`);
    }
    return 0;
  }

  if (json) {
    console.log(formatJson(captureJsonDocument(outcome)));
  } else {
    const r = outcome.result;
    printCaptureSummary({
      vaultPath: r.vault,
      relPath: r.path,
      title: r.title,
      branch: r.branch,
      commitOid: r.commit,
      serveStatus: r.serveStatus,
      adoptedInitialized: r.adoptedInitialized,
      compilePending: r.compilePending,
    });
  }
  return 0;
}

// ----- internals ------------------------------------------------------------

function realStdin(): CaptureStdin {
  return {
    isTTY: process.stdin.isTTY === true,
    readToEnd: () => Bun.stdin.text(),
  };
}

/**
 * Find an existing raw capture whose filename slug matches — the
 * captureId-idempotency lookup. Filenames are `<YYYY-MM-DD-HHmm>-<slug>.md`,
 * so the stamp prefix is matched structurally and the slug exactly.
 */
function findCaptureBySlug(vaultPath: string, slug: string): string | null {
  const dir = join(vaultPath, RAW_INBOX_DIR);
  if (!existsSync(dir)) return null;
  const pattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}-\\d{4}-${escapeRegExp(slug)}\\.md$`,
  );
  for (const name of readdirSync(dir)) {
    if (pattern.test(name)) return `${RAW_INBOX_DIR}/${name}`;
  }
  return null;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve the vault-relative target path, disambiguating working-tree
 * collisions deterministically: `<stamp>-<slug>.md`, then `-2`, `-3`, …
 */
function resolveTargetPath(
  vaultPath: string,
  stamp: string,
  slug: string,
): string {
  const base = `${RAW_INBOX_DIR}/${stamp}-${slug}`;
  let relPath = `${base}.md`;
  let n = 2;
  while (existsSync(join(vaultPath, relPath))) {
    relPath = `${base}-${n}.md`;
    n += 1;
  }
  return relPath;
}

/** Skip a leading `---` frontmatter block for title derivation. */
function stripLeadingFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return content;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") return lines.slice(i + 1).join("\n");
  }
  return content;
}

function printCaptureSummary(input: {
  readonly vaultPath: string;
  readonly relPath: string;
  readonly title: string;
  readonly branch: string;
  readonly commitOid: string;
  readonly serveStatus: "running" | "stale" | "off";
  readonly adoptedInitialized: boolean;
  readonly compilePending: boolean;
}): void {
  const caps = resolveCaps();
  const tone: Status = { tone: "ok", label: "captured" };
  const rows: KvRow[] = [
    { label: "path", value: input.relPath },
    { label: "title", value: input.title },
    { label: "commit", value: `${input.commitOid.slice(0, 7)} on ${input.branch}` },
    { label: "vault", value: input.vaultPath, tone: "muted" },
  ];
  const lines = [
    headline(
      { cmd: "capture", context: basename(input.vaultPath) },
      tone,
      caps,
    ),
    ...section("Capture", kv(rows, caps), caps),
    ...section("Next", bullets(nextHints(input), caps, "none"), caps),
    ...footer(tone, caps),
  ];
  console.log(lines.join("\n"));
}

function nextHints(input: {
  readonly serveStatus: "running" | "stale" | "off";
  readonly adoptedInitialized: boolean;
  readonly compilePending: boolean;
}): ReadonlyArray<string> {
  if (!input.compilePending) {
    return [
      "the running serve host will adopt and ingest this capture on its next tick",
    ];
  }
  const hints: string[] = [];
  if (input.serveStatus !== "running") {
    hints.push(
      `compile pending — no running serve host (serve ${input.serveStatus}); run \`dome sync\` or start \`dome serve\``,
    );
  }
  if (!input.adoptedInitialized) {
    hints.push(
      "adopted ref not initialized for this branch; the first `dome sync` (or serve tick) will adopt the capture",
    );
  }
  return hints;
}


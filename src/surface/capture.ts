// surface/capture: the capture data core — Phase 3 of the product wedge
// (docs/wedge.md §"Phase 3 — Capture loop").
//
// Per docs/wiki/specs/cli.md §"dome capture" + docs/wiki/specs/capture.md,
// this is the frictionless ingress verb: take a thought from an argument,
// a file, or stdin; write it as a timestamped raw capture under `inbox/raw/`;
// commit exactly that one file on the current branch; return immediately.
// Everything after the commit boundary is the existing capture loop (the
// compiler host adopts, `dome.agent.ingest` integrates, the stale-check
// warns) — capture never talks to the engine. `dome capture` and the MCP
// `capture` tool both render the returned outcome; nothing here prints.
//
// Design constraints carried from the spec:
//
//   - The commit is a HUMAN write: ordinary message `capture: <title>` plus
//     `Dome-Request` attribution, never the engine's Dome-Run/Base trailer
//     family. The daemon constructs the Proposal from branch drift like any
//     other human commit (PROPOSALS_ARE_THE_ONLY_WRITE_PATH).
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
// Mutation-boundary note: this surface plans capture bytes, then delegates all
// filesystem/ref/index work to `src/mutation/controlled-mutation.ts`. The
// resulting ordinary commit is still a human-side compiler-boundary write,
// not an engine-applied Effect.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getAdoptedRef } from "../adopted-ref";
import {
  readServeHeartbeatStatus,
} from "../engine/host/compiler-host-heartbeat";
import {
  currentBranch,
  currentSha,
  findGitRoot,
} from "../git";
import { applyControlledMutation } from "../mutation/controlled-mutation";
import { resolveVaultPath } from "./resolve-vault";
import {
  CAPTURE_SCHEMA,
  type CaptureReceipt,
} from "../../contracts/capture";

// ----- Constants ------------------------------------------------------------

const EX_USAGE = 64;

const RAW_INBOX_DIR = "inbox/raw";

/**
 * Where dome.agent archives consumed captures, basename preserved
 * (vault-tools' archiveSource). The captureId-dedup scan must cover it:
 * a queued copy re-captured AFTER the original was ingested and archived
 * would otherwise double-file.
 */
const PROCESSED_INBOX_DIR = "inbox/processed";

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
  /**
   * Client-supplied retry-idempotency key ([[wiki/specs/capture]] §"Retry
   * semantics"): it drives the filename slug, and an existing capture for
   * the same id answers `duplicate` instead of writing. On the CLI this is
   * `--capture-id` — the queue-drain seam (a re-run after a crash between
   * capture and queue-file delete must not double-file).
   */
  readonly captureId?: string | undefined;
  readonly vault?: string | undefined;
  readonly json?: boolean | undefined;
};

/**
 * `performCapture` options — the CLI option set plus the remote-capture-seam
 * field ([[wiki/specs/capture]] §"The remote-capture seam"): `source` is the
 * honest ingress channel written into frontmatter (default `cli`).
 */
export type PerformCaptureOptions = Omit<RunCaptureOptions, "json"> & {
  readonly source?: string | undefined;
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
  readonly captureId?: string;
};

/**
 * The data-returning outcome of one capture attempt. `runCapture` renders
 * it for the terminal; the MCP `capture` tool renders it as the same
 * `dome.capture/v1` document via `captureJsonDocument`.
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
): CaptureReceipt {
  if (outcome.kind === "error") {
    return {
      schema: CAPTURE_SCHEMA,
      status: "error",
      vault: outcome.vault,
      error: outcome.error,
    };
  }
  if (outcome.kind === "duplicate") {
    return {
      schema: CAPTURE_SCHEMA,
      status: "duplicate",
      vault: outcome.vault,
      path: outcome.path,
      capture_id: outcome.captureId,
      commit_status: "already-committed",
      adoption_status: "unknown",
    };
  }
  const r = outcome.result;
  return {
    schema: CAPTURE_SCHEMA,
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
    ...(r.captureId !== undefined ? { capture_id: r.captureId } : {}),
    commit_status: "committed",
    adoption_status: "pending",
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
 * Injectable host boundaries for `performCapture`. `now` drives both the
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
  readonly captureId?: string | undefined;
}): string {
  const lines = [
    "---",
    `captured: ${input.capturedAt}`,
    `source: ${input.source ?? "cli"}`,
  ];
  if (input.title !== undefined) {
    lines.push(`title: ${JSON.stringify(input.title)}`);
  }
  if (input.captureId !== undefined) {
    lines.push(`capture_id: ${JSON.stringify(input.captureId)}`);
  }
  lines.push("---", "", input.body.trim(), "");
  return lines.join("\n");
}

// ----- performCapture ---------------------------------------------------------

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
    if (
      captureId !== undefined &&
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(captureId)
    ) {
      return failWith(
        EX_USAGE,
        "invalid capture id: expected 1-128 chars of [a-z0-9._:-]",
      );
    }
    const slug =
      captureId !== undefined
        ? captureSlug(captureId)
        : captureSlug(explicitTitle ?? derivedTitle);
    if (captureId !== undefined) {
      const existing = findCaptureById(vaultPath, captureId, slug);
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
      ...(captureId !== undefined ? { captureId } : {}),
    });

    // Ordinary human commit: `capture: <title>`, no Dome-* trailers. Built
    // against the HEAD tree plus this one blob so nothing else — staged or
    // dirty — rides along.
    const mutation = await applyControlledMutation({
      vaultPath,
      branch,
      requestId: captureId ?? `capture:${capturedAt}:${relPath}`,
      files: [{ path: relPath, expectedContent: null, content: document }],
      message: `capture: ${title}`,
      author: { name: "dome capture", email: "dome-capture@local" },
    });
    if (mutation.kind !== "committed") {
      const detail = mutation.kind === "diverged"
        ? `checkout diverged at ${mutation.paths.join(", ")}; recovery journal: ${mutation.journalPath}`
        : mutation.kind === "busy"
          ? `mutation lane busy at ${mutation.lockPath}`
          : `working tree changed at ${mutation.paths.join(", ") || relPath}`;
      return failWith(1, `failed: ${detail}`);
    }
    const commitOid = mutation.commit;

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
        ...(captureId !== undefined ? { captureId } : {}),
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failWith(1, `failed: ${msg}`);
  }
}

// ----- internals ------------------------------------------------------------

function realStdin(): CaptureStdin {
  return {
    isTTY: process.stdin.isTTY === true,
    readToEnd: () => Bun.stdin.text(),
  };
}

/**
 * Find an existing logical capture by its durable frontmatter identity.
 * The filename lookup remains only as a compatibility fallback for captures
 * written before `capture_id` was embedded in the artifact.
 *
 * Scans BOTH `inbox/raw/` and `inbox/processed/`: ingestion archives a
 * consumed capture to processed with its basename preserved, so a raw-only
 * scan would let a queued copy re-captured after ingestion double-file.
 * Either directory may be absent (a vault that has never archived, or a
 * bare vault before the first capture) — a missing dir is simply skipped.
 */
function findCaptureById(
  vaultPath: string,
  captureId: string,
  legacySlug: string,
): string | null {
  const pattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}-\\d{4}-${escapeRegExp(legacySlug)}\\.md$`,
  );
  let legacyMatch: string | null = null;
  const identityLine = `capture_id: ${JSON.stringify(captureId)}`;
  for (const dirRel of [RAW_INBOX_DIR, PROCESSED_INBOX_DIR]) {
    const dir = join(vaultPath, dirRel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const relPath = `${dirRel}/${name}`;
      try {
        const content = readFileSync(join(vaultPath, relPath), "utf8");
        const lines = content.split(/\r?\n/);
        if (lines.includes(identityLine)) return relPath;
        if (
          legacyMatch === null &&
          !lines.some((line) => line.startsWith("capture_id:")) &&
          pattern.test(name)
        ) {
          legacyMatch = relPath;
        }
      } catch {
        // A concurrent archive/remove can make a directory entry disappear.
      }
    }
  }
  return legacyMatch;
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

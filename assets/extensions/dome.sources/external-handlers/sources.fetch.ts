// sources.fetch — the dome.sources external handler.
//
// Bound by the bundle loader from the filename stem (the first shipped use
// of the `external-handlers/` contribution kind,
// [[wiki/matrices/extension-bundle-shape]]). The outbox dispatcher invokes
// it for every `sources.fetch` outbox row; `openVaultRuntime` injects the
// vault root into bundle handler input.
//
// The handler is generic over subscription kinds: everything kind-specific
// lives in the vault-configured fetch command. The contract
// ([[wiki/specs/sources]] §"The handler contract"):
//
//   1. Validate the payload (defense in depth — the row is data).
//   2. Re-derive the subscription from the CURRENT `.dome/config.yaml` by
//      kind (the config is the consent surface, re-checked at dispatch
//      time; [[wiki/specs/sources]] §"Consent is re-checked at dispatch").
//      A payload whose command or rendered output path no longer matches
//      the live config → throw. Revocation is immediate: a config flip
//      kills queued rows.
//   3. Output file already committed at HEAD → { recovered: true } without
//      spawning (idempotent crash recovery: a prior attempt's command
//      succeeded — wrote AND committed — but the engine died before
//      markSent). The check reads HEAD, never the working tree: a write
//      without a commit is an incomplete fetch, not a success.
//   4. Spawn `[...command, date, output_path]` with cwd = vault root, in
//      its OWN PROCESS GROUP (`detached: true`), stdout ignored (a chatty
//      fetcher must never deadlock the pipe), stderr captured for
//      diagnostics. The command fetches, writes the file, and COMMITS it
//      as an ordinary non-engine commit (PROPOSALS_ARE_THE_ONLY_WRITE_PATH
//      stays intact — this handler never touches vault content).
//   5. The engine's dispatch AbortSignal (timeout / shutdown) SIGTERMs the
//      process group, then escalates to SIGKILL after a short grace — so a
//      TERM-trapping script or a `sh → claude` grandchild tree dies too
//      (mirrors src/engine/command-model-provider.ts's probe escalation).
//   6. Non-zero exit → throw (ordinary outbox retry semantics).
//   7. Exit 0 but the file absent from HEAD → throw. Written-but-
//      uncommitted gets its own message — the retry re-spawns the command,
//      whose contract is to skip the fetch and just commit the existing
//      file (the cheap commit-only retry).
//
// The attempt is bounded by `engine.external_handler_timeout_ms`
// (default 30s).

import { existsSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import { loadCapabilityPolicy } from "../../../../src/engine/capability-policy";
import { readBlob, resolveRef } from "../../../../src/git";
import type {
  ExternalHandler,
  ExternalHandlerInput,
  ExternalHandlerResult,
} from "../../../../src/outbox/dispatch";
import {
  renderOutputPath,
  resolveSubscriptions,
  type SourceSubscription,
} from "../processors/fetch";

const EXTENSION_ID = "dome.sources";

/**
 * Grace between the abort's SIGTERM and the SIGKILL escalation. SIGTERM is
 * advisory; a trapping/ignoring fetch script would otherwise leave the
 * attempt awaiting `proc.exited` past the dispatch timeout. Mirrors
 * PROBE_KILL_GRACE_MS in src/engine/command-model-provider.ts.
 */
const KILL_GRACE_MS = 500;

type FetchPayload = {
  readonly kind: string;
  readonly date: string;
  readonly outputPath: string;
  readonly command: ReadonlyArray<string>;
};

function parsePayload(raw: unknown): FetchPayload {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sources.fetch payload must be an object");
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  const date = record.date;
  const outputPath = record.output_path;
  const command = record.command;
  if (typeof kind !== "string" || kind.length === 0) {
    throw new Error("sources.fetch payload.kind must be a non-empty string");
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("sources.fetch payload.date must be YYYY-MM-DD");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error(
      "sources.fetch payload.output_path must be a non-empty string",
    );
  }
  // Defense in depth: the processor validates the template, but the outbox
  // row is data — re-reject anything that could escape the vault root or
  // the sources/ committed-feed category (symmetry with
  // outputPathTemplateProblem in ../processors/fetch.ts).
  if (
    isAbsolute(outputPath) ||
    outputPath.includes("\\") ||
    normalize(outputPath).split("/").includes("..")
  ) {
    throw new Error(
      "sources.fetch payload.output_path must be a relative vault path",
    );
  }
  if (!outputPath.endsWith(".md")) {
    throw new Error("sources.fetch payload.output_path must end with .md");
  }
  if (!outputPath.startsWith("sources/")) {
    throw new Error(
      "sources.fetch payload.output_path must live under sources/ " +
        "(the committed-feed category)",
    );
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error(
      "sources.fetch payload.command must be a non-empty list of strings",
    );
  }
  return Object.freeze({
    kind,
    date,
    outputPath,
    command: Object.freeze([...(command as string[])]),
  });
}

/**
 * Re-derive the subscription from the live `.dome/config.yaml` — the config
 * IS the consent surface, and the outbox row only snapshots what was
 * consented at emit time. The payload must still match: a flipped/removed
 * subscription, a changed command, or a changed output path between emit
 * and dispatch refuses the row (throws → ordinary retry → terminal failure,
 * visible in `dome check`). This is what keeps the `sources.fetch` grant
 * from being an arbitrary-exec channel for anything that can write a row.
 */
async function consentedSubscription(
  vaultPath: string,
  payload: FetchPayload,
): Promise<SourceSubscription> {
  const policy = await loadCapabilityPolicy(vaultPath);
  if (!policy.ok) {
    throw new Error(
      `sources.fetch could not re-check consent against .dome/config.yaml: ${policy.error}`,
    );
  }
  if (policy.value.foundConfig && !policy.value.isExtensionEnabled(EXTENSION_ID)) {
    throw new Error(
      `sources.fetch "${payload.kind}" refused: the ${EXTENSION_ID} extension ` +
        "is not enabled in .dome/config.yaml (consent revoked or config " +
        "changed since the row was enqueued)",
    );
  }
  const { subscriptions } = resolveSubscriptions(
    policy.value.configForExtension(EXTENSION_ID),
  );
  const subscription = subscriptions.find((s) => s.kind === payload.kind);
  if (subscription === undefined) {
    throw new Error(
      `sources.fetch "${payload.kind}" refused: no enabled "${payload.kind}" ` +
        "subscription in .dome/config.yaml (consent revoked or config " +
        "changed since the row was enqueued)",
    );
  }
  const expectedPath = renderOutputPath(
    subscription.outputPathTemplate,
    payload.date,
  );
  if (expectedPath !== payload.outputPath) {
    throw new Error(
      `sources.fetch "${payload.kind}" refused: payload output_path ` +
        `${payload.outputPath} does not match the configured subscription's ` +
        `${expectedPath} (config changed since the row was enqueued)`,
    );
  }
  if (!sameCommand(subscription.command, payload.command)) {
    throw new Error(
      `sources.fetch "${payload.kind}" refused: payload command does not ` +
        "match the configured subscription command in .dome/config.yaml — " +
        "refusing to run a command the config no longer consents to",
    );
  }
  return subscription;
}

function sameCommand(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

/**
 * Whether the vault-relative path exists as a blob in the vault's HEAD
 * commit. The completion check for a fetch: the command's contract is to
 * write AND commit, so only a committed file counts (a working-tree file
 * the daemon will never adopt must not mark the row sent). Unborn HEAD
 * (no commits yet) reads as "not committed".
 */
async function committedAtHead(
  vaultPath: string,
  filepath: string,
): Promise<boolean> {
  let head: string;
  try {
    head = await resolveRef({ path: vaultPath });
  } catch {
    return false;
  }
  return (await readBlob({ path: vaultPath, commit: head, filepath })) !== null;
}

const sourcesFetch: ExternalHandler = async (
  input: ExternalHandlerInput,
): Promise<ExternalHandlerResult> => {
  const payload = parsePayload(input.payload);
  const vaultPath = input.vaultPath;
  if (vaultPath === undefined) {
    throw new Error(
      "sources.fetch handler requires the engine-injected vaultPath " +
        "(bundle handlers receive it from openVaultRuntime)",
    );
  }
  const externalId = `${payload.kind}:${payload.date}`;
  const subscription = await consentedSubscription(vaultPath, payload);

  if (await committedAtHead(vaultPath, payload.outputPath)) {
    // A prior attempt's command already produced AND committed the file
    // (crash between the command's commit and markSent, or a concurrent
    // manual run). A working-tree-only file deliberately does NOT recover —
    // it falls through to the spawn, whose commit-only retry completes it.
    return { externalId, recovered: true };
  }
  if (input.signal.aborted) {
    throw new Error(
      `sources.fetch "${payload.kind}" fetch command was aborted before it started`,
    );
  }

  const proc = Bun.spawn(
    [...subscription.command, payload.date, payload.outputPath],
    {
      cwd: vaultPath,
      stdin: "ignore",
      // Never drained, so never piped: a fetcher that logs >64KB to stdout
      // would deadlock against a full pipe and ride out the dispatch
      // timeout. Diagnostics belong on stderr (captured below).
      stdout: "ignore",
      stderr: "pipe",
      // Own process group, so the abort path can kill the whole
      // `sh → fetcher` tree, not just the direct child.
      detached: true,
    },
  );
  const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      // detached: true puts the child in its own group (pgid = pid);
      // signalling the negative pid reaches every descendant.
      process.kill(-proc.pid, signal);
    } catch {
      // Group already reaped (ESRCH) or unkillable — fall back to the
      // direct child, best-effort.
      proc.kill(signal);
    }
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    killGroup("SIGTERM");
    // SIGTERM is advisory; escalate after a short grace so a trapping
    // script cannot hold the attempt open.
    killTimer = setTimeout(() => {
      killGroup("SIGKILL");
    }, KILL_GRACE_MS);
  };
  input.signal.addEventListener("abort", onAbort, { once: true });
  let exitCode: number;
  let stderrText: string;
  try {
    [exitCode, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }

  if (input.signal.aborted) {
    throw new Error(
      `sources.fetch "${payload.kind}" fetch command was aborted before completing`,
    );
  }
  if (exitCode !== 0) {
    const excerpt = stderrText.trim().slice(0, 400);
    throw new Error(
      `sources.fetch "${payload.kind}" fetch command exited ${exitCode}` +
        (excerpt.length > 0 ? `: ${excerpt}` : ""),
    );
  }
  if (!(await committedAtHead(vaultPath, payload.outputPath))) {
    if (existsSync(join(vaultPath, payload.outputPath))) {
      throw new Error(
        `sources.fetch "${payload.kind}" fetch command wrote ` +
          `${payload.outputPath} but did not commit it (gpg/hook failure, or ` +
          "killed mid-script?) — the retry will commit the existing file",
      );
    }
    throw new Error(
      `sources.fetch "${payload.kind}" fetch command exited 0 but did not write ${payload.outputPath}`,
    );
  }
  return { externalId };
};

export default sourcesFetch;

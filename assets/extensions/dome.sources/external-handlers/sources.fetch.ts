// sources.fetch — the dome.sources external handler.
//
// Bound by the bundle loader from the filename stem (the first shipped use
// of the `external-handlers/` contribution kind,
// [[wiki/matrices/extension-bundle-shape]]). The outbox dispatcher invokes
// it for every `sources.fetch` outbox row; `openVaultRuntime` injects the
// vault root into bundle handler input.
//
// The handler is generic over subscription kinds: everything kind-specific
// lives in the vault-configured fetch command carried by the payload. The
// contract ([[wiki/specs/sources]] §"The handler contract"):
//
//   1. Validate the payload (defense in depth — the row is data).
//   2. Output file already on disk → { recovered: true } without spawning
//      (idempotent crash recovery: a prior attempt's command succeeded but
//      the engine died before markSent).
//   3. Spawn `[...command, date, output_path]` with cwd = vault root. The
//      command fetches, writes the file, and COMMITS it as an ordinary
//      non-engine commit (PROPOSALS_ARE_THE_ONLY_WRITE_PATH stays intact —
//      this handler never touches vault content).
//   4. Non-zero exit → throw (ordinary outbox retry semantics).
//   5. Exit 0 but no output file → throw (a silent no-op fetch must be
//      visible, never "sent").
//
// The engine's dispatch AbortSignal kills the child (timeout / shutdown);
// the attempt is bounded by `engine.external_handler_timeout_ms`
// (default 30s).

import { existsSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type {
  ExternalHandler,
  ExternalHandlerInput,
  ExternalHandlerResult,
} from "../../../../src/outbox/dispatch";

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
  // row is data — re-reject anything that could escape the vault root.
  if (
    isAbsolute(outputPath) ||
    outputPath.includes("\\") ||
    normalize(outputPath).split("/").includes("..")
  ) {
    throw new Error(
      "sources.fetch payload.output_path must be a relative vault path",
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
  const outputAbs = join(vaultPath, payload.outputPath);

  if (existsSync(outputAbs)) {
    // A prior attempt's command already produced the file (crash between
    // the command's commit and markSent, or a concurrent manual run).
    return { externalId, recovered: true };
  }

  const proc = Bun.spawn(
    [...payload.command, payload.date, payload.outputPath],
    {
      cwd: vaultPath,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const onAbort = (): void => {
    proc.kill();
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
  if (!existsSync(outputAbs)) {
    throw new Error(
      `sources.fetch "${payload.kind}" fetch command exited 0 but did not write ${payload.outputPath}`,
    );
  }
  return { externalId };
};

export default sourcesFetch;

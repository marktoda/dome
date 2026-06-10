// cli/commands/capture: `dome capture` — the CLI binding for the capture
// verb. The data core (input resolution, raw-capture write, single-file
// commit) lives in src/surface/capture.ts and is shared with the MCP
// `capture` tool; this module owns terminal rendering only.
//
// House-style notes (matches src/cli/commands/install.ts):
//   - `type X = { ... }` aliases, every field `readonly`.
//   - The handler returns the exit code; the dispatcher calls
//     `process.exit(code)`.
//   - Testability via an injected deps object (clock + stdin boundary).

import { basename } from "node:path";

import {
  captureJsonDocument,
  performCapture,
  type CaptureDeps,
  type RunCaptureOptions,
} from "../../surface/capture";
import { formatJson } from "../../surface/format";
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

export type { CaptureDeps, RunCaptureOptions } from "../../surface/capture";

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

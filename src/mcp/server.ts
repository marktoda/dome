// mcp/server: the Dome MCP protocol adapter — wedge Phase 5.
//
// Per docs/wiki/specs/mcp-surface.md, this is a THIN adapter: every tool
// resolves to the same code path the corresponding CLI verb uses, and tool
// results are the same `dome.<verb>/v1` JSON documents the CLI emits under
// `--json`. There is no parallel query/serialization logic here.
//
//   capture        → runCapture            (dome.capture/v1)
//   query          → runQuery              (dome.search.query/v1)
//   export_context → runExportContext      (dome.search.export-context/v1)
//   status         → runStatus             (status snapshot, stable keys)
//   check          → runCheck              (dome.check/v1)
//   resolve        → runResolve            (dome.answer/v1)
//   tasks          → today view via runStructuredViewCommand
//                                          (dome.daily.today/v1)
//   brief          → today view + adopted-commit blob read
//                                          (dome.mcp.brief/v1)
//
// Boundary notes:
//
//   - The CLI handlers print via console.log. Tool execution therefore runs
//     under a captured-console mutex (the same pattern the test harness's
//     `runCli` uses): the captured `--json` document becomes the tool
//     result, and handler output can never leak onto stdout — which, for a
//     stdio MCP server, is the protocol channel.
//   - The mutex also serializes tool calls, so at most one VaultRuntime is
//     open at a time. Each call opens and closes its own runtime exactly
//     like one CLI invocation; no long-lived SQLite handle is held.
//   - This module statically imports @modelcontextprotocol/sdk and is a
//     companion entrypoint (`@dome/sdk/mcp`, hosted by `dome mcp`). It must
//     never be imported from the static graph of src/index.ts — pinned by
//     ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY and enforced by
//     tests/integration/bundle-deps.test.ts.
//   - No engine control here: no sync/serve/init/rebuild tools. The daemon
//     owns compilation; `capture` and `resolve` reuse the existing
//     non-engine write channels (ordinary human commit; answers.db).

import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";

import { runCapture } from "../cli/commands/capture";
import { runCheck } from "../cli/commands/check";
import { runExportContext } from "../cli/commands/export-context";
import { runQuery } from "../cli/commands/query";
import { runResolve } from "../cli/commands/resolve";
import { runStatus } from "../cli/commands/status";
import {
  firstPartyViewNotFoundMessage,
  runStructuredViewCommand,
  type StructuredViewCommandResult,
} from "../cli/commands/view-shared";
import { formatJson } from "../cli/format";
import { readBlob } from "../git";

// ----- Constants ------------------------------------------------------------

const SERVER_NAME = "dome";
const SERVER_VERSION = "0.1.0";

const BRIEF_SCHEMA = "dome.mcp.brief/v1";
const TODAY_VIEW_NAME = "dome.daily.today";
const TODAY_VIEW_SCHEMA = "dome.daily.today/v1";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const SERVER_INSTRUCTIONS = `Dome MCP server — a read/capture surface over one Dome vault.
Markdown plus git history are the source of truth; a separate daemon
(\`dome serve\`, kept alive by \`dome install\`) compiles commits into adopted
state. This server never compiles — captures and resolutions are durable
immediately and compile in the background.

Typical loop:
- capture: drop a thought into inbox/raw/ (committed immediately).
- status: vault pulse — attention codes and next_actions.
- check: explain attention — engine health, diagnostics, open decisions.
- resolve: answer a Dome-raised question by id (omit value to read it).
- query / export_context: adopted-state recall with source refs.
- brief / tasks: today's daily note content and source-backed open loops.

All results are JSON documents matching the CLI's --json schemas.`;

// ----- Public types ---------------------------------------------------------

export type DomeMcpServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
};

// ----- Captured CLI execution (exported for tests) ---------------------------

export type CapturedCliRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Build the tool-execution mutex for one server. Tool handlers chain onto a
 * shared promise so calls run one at a time: console capture is global
 * state, and serializing also guarantees at most one VaultRuntime is open
 * against the vault's SQLite files at any moment. The chain lives in the
 * server closure (one mutex per createDomeMcpServer call), though note the
 * console capture itself is process-global, so two servers in one process
 * still must not interleave captured runs — each server's chain serializes
 * its own calls, and the capture swap/restore is confined to each run.
 */
function makeToolMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let toolChain: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = toolChain.then(fn, fn);
    toolChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/**
 * Run a CLI command handler with console.log/console.error captured.
 * Returns the exit code plus joined stdout/stderr text. Must only be
 * called from inside `enqueue` (the capture swaps global console state).
 */
async function runWithCapturedConsole(
  fn: () => Promise<number>,
): Promise<CapturedCliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(stringifyConsoleArg).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(stringifyConsoleArg).join(" "));
  };
  try {
    const exitCode = await fn();
    return Object.freeze({
      exitCode,
      stdout: out.join("\n"),
      stderr: err.join("\n"),
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function stringifyConsoleArg(part: unknown): string {
  return typeof part === "string" ? part : String(part);
}

// ----- Tool result shaping ----------------------------------------------------

type ToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
};

/** Map a captured CLI run to an MCP tool result. Non-zero exit → isError. */
function cliToolResult(run: CapturedCliRun): ToolResult {
  const text = run.stdout.trim().length > 0 ? run.stdout : run.stderr;
  return {
    content: [
      {
        type: "text" as const,
        text: text.trim().length > 0 ? text : "(no output)",
      },
    ],
    ...(run.exitCode === 0 ? {} : { isError: true }),
  };
}

function jsonToolResult(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: formatJson(data) }] };
}

function errorToolResult(messages: ReadonlyArray<string>): ToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: formatJson({
          status: "error",
          message: messages[0] ?? "tool failed",
          messages,
        }),
      },
    ],
    isError: true,
  };
}

/** Map a structured-view-shaped run (`ok`/`error`) to an MCP tool result. */
function structuredToolResult(
  run:
    | { readonly kind: "ok"; readonly data: unknown }
    | { readonly kind: "error"; readonly messages: ReadonlyArray<string> },
): ToolResult {
  return run.kind === "error"
    ? errorToolResult(run.messages)
    : jsonToolResult(run.data);
}

// ----- The server -------------------------------------------------------------

/**
 * Build the Dome MCP server for one vault. The caller owns the transport:
 * `dome mcp` connects stdio; tests connect an in-memory pair.
 */
export function createDomeMcpServer(opts: DomeMcpServerOptions): McpServer {
  const vault = opts.vaultPath;
  const bundlesRoot = opts.bundlesRoot;
  const enqueue = makeToolMutex();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /**
   * Register one CLI-backed tool: the handler maps validated tool args to a
   * `runXxx({ ..., json: true })` CLI handler, and the shared plumbing —
   * mutex enqueue, console capture, exit-code → isError shaping — is
   * identical for every such tool. The `tasks`/`brief` tools register
   * directly because they compose structured views instead of capturing a
   * CLI handler's console output.
   */
  const registerCliTool = <Shape extends ZodRawShapeCompat>(
    name: string,
    config: {
      readonly title: string;
      readonly description: string;
      readonly inputSchema: Shape;
    },
    run: (args: ShapeOutput<Shape>) => Promise<number>,
  ): void => {
    const callback = async (args: ShapeOutput<Shape>) =>
      cliToolResult(
        await enqueue(() => runWithCapturedConsole(() => run(args))),
      );
    // `ToolCallback<Shape>` is a conditional type the compiler cannot
    // resolve (or overlap-check) while `Shape` is still generic; `callback`
    // is exactly its raw-shape branch (`(args: ShapeOutput<Shape>) => ...`),
    // which every monomorphic call site below instantiates.
    server.registerTool(
      name,
      config,
      callback as unknown as ToolCallback<Shape>,
    );
  };

  registerCliTool(
    "capture",
    {
      title: "Capture a thought into the vault inbox",
      description:
        "Write text into inbox/raw/ as a timestamped raw capture and commit " +
        "exactly that one file on the current branch. Returns the " +
        "dome.capture/v1 JSON payload; compile_pending reports whether a " +
        "running daemon will pick it up.",
      inputSchema: {
        text: z.string().min(1).describe(
          "Capture body (markdown or plain text).",
        ),
        title: z.string().optional().describe(
          "Optional explicit title; drives the filename slug and commit message.",
        ),
      },
    },
    ({ text, title }) =>
      runCapture({
        text,
        ...(title !== undefined ? { title } : {}),
        vault,
        json: true,
      }),
  );

  registerCliTool(
    "query",
    {
      title: "Query adopted vault state",
      description:
        "Full-text + structured query against adopted state. Returns the " +
        "dome.search.query/v1 JSON payload: matches with source refs, " +
        "related facts, diagnostics, and open questions.",
      inputSchema: {
        text: z.string().min(1).describe("Query text (FTS)."),
        limit: z.number().int().positive().optional().describe(
          "Maximum matches to return.",
        ),
        category: z.string().optional().describe(
          "Filter by document category.",
        ),
        type: z.string().optional().describe("Filter by page type."),
      },
    },
    ({ text, limit, category, type }) =>
      runQuery({
        text,
        limit,
        category,
        type,
        vault,
        bundlesRoot,
        json: true,
      }),
  );

  registerCliTool(
    "export_context",
    {
      title: "Export a source-backed context packet",
      description:
        "Portable source-backed context packet for a topic — the read-first " +
        "surface for handoffs, planning, and multi-file work. Returns the " +
        "dome.search.export-context/v1 JSON payload (markdown + source refs).",
      inputSchema: {
        topic: z.string().min(1).describe("Topic to export."),
        limit: z.number().int().positive().optional().describe(
          "Maximum matches to include.",
        ),
      },
    },
    ({ topic, limit }) =>
      runExportContext({ topic, limit, vault, bundlesRoot, json: true }),
  );

  registerCliTool(
    "status",
    {
      title: "Vault status pulse",
      description:
        "Read-only vault dashboard: git cursor, attention codes, " +
        "next_actions, serve/daemon state, content analytics, and " +
        "operational counts. Same stable-key JSON as `dome status --json`.",
      inputSchema: {},
    },
    () => runStatus({ vault, bundlesRoot, json: true }),
  );

  registerCliTool(
    "check",
    {
      title: "Explain compiler attention",
      description:
        "Unified read-only attention report: engine health, adopted-state " +
        "content diagnostics, and open Dome decisions with resolve " +
        "commands. Returns the dome.check/v1 JSON payload.",
      inputSchema: {
        engine: z.boolean().optional().describe(
          "Show only engine health findings.",
        ),
        content: z.boolean().optional().describe(
          "Show only adopted-state diagnostics.",
        ),
        decisions: z.boolean().optional().describe(
          "Show only open Dome questions.",
        ),
        attention: z.boolean().optional().describe(
          "For content diagnostics, only warning/error/block rows.",
        ),
        limit: z.number().int().positive().optional().describe(
          "Maximum rows per section.",
        ),
      },
    },
    ({ engine, content, decisions, attention, limit }) =>
      runCheck({
        engine,
        content,
        decisions,
        attention,
        limit,
        vault,
        bundlesRoot,
        json: true,
      }),
  );

  registerCliTool(
    "resolve",
    {
      title: "Resolve a Dome-raised decision",
      description:
        "Answer a durable Dome question by id (ids come from `check`). " +
        "Omit value to read the question first. Records the answer in " +
        "answers.db and dispatches answer handlers — the same path as " +
        "`dome resolve`. Returns the dome.answer/v1 JSON payload.",
      inputSchema: {
        id: z.number().int().positive().describe(
          "Question row id from the check tool.",
        ),
        value: z.string().optional().describe(
          "Decision value. Omit to read the question without answering.",
        ),
      },
    },
    ({ id, value }) => runResolve({ id, value, vault, bundlesRoot, json: true }),
  );

  server.registerTool(
    "tasks",
    {
      title: "Source-backed open loops for a day",
      description:
        "The dome.daily today view: open tasks, followups, and open Dome " +
        "questions for a day, ranked and source-backed. Returns the " +
        "dome.daily.today/v1 JSON payload.",
      inputSchema: {
        date: z.string().regex(DATE_PATTERN).optional().describe(
          "Day to render (YYYY-MM-DD; defaults to local today).",
        ),
        limit: z.number().int().positive().optional().describe(
          "Maximum rows per list.",
        ),
      },
    },
    async ({ date, limit }) =>
      structuredToolResult(
        await enqueue(() => runTodayView({ vault, bundlesRoot, date, limit })),
      ),
  );

  server.registerTool(
    "brief",
    {
      title: "Read the daily note (the morning brief)",
      description:
        "Today's daily note content at the adopted commit, plus open-loop " +
        "counts — the morning-brief read surface. Returns the " +
        "dome.mcp.brief/v1 JSON payload ({ date, path, exists, content, " +
        "counts }).",
      inputSchema: {
        date: z.string().regex(DATE_PATTERN).optional().describe(
          "Day to read (YYYY-MM-DD; defaults to local today).",
        ),
      },
    },
    async ({ date }) =>
      structuredToolResult(
        await enqueue(async () => {
          const view = await runTodayView({ vault, bundlesRoot, date });
          if (view.kind === "error") return view;
          const source = parseBriefSource(view.data);
          const content =
            source.exists && source.commit !== null
              ? await readBlob({
                  path: vault,
                  commit: source.commit,
                  filepath: source.path,
                })
              : null;
          return Object.freeze({
            kind: "ok" as const,
            data: Object.freeze({
              schema: BRIEF_SCHEMA,
              date: source.date,
              path: source.path,
              exists: source.exists,
              content,
              counts: source.counts,
            }),
          });
        }),
      ),
  );

  return server;
}

// ----- internals --------------------------------------------------------------

/**
 * Dispatch the `today` view through the same structured-view boundary the
 * CLI uses (`dome run today` / the dedicated view wrappers).
 */
async function runTodayView(input: {
  readonly vault: string;
  readonly bundlesRoot: string | undefined;
  readonly date?: string | undefined;
  readonly limit?: number | undefined;
}): Promise<StructuredViewCommandResult> {
  return runStructuredViewCommand({
    commandLabel: "dome mcp tasks",
    commandName: "today",
    expectedViewName: TODAY_VIEW_NAME,
    expectedSchema: TODAY_VIEW_SCHEMA,
    commandArgs: Object.freeze({
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
    vault: input.vault,
    bundlesRoot: input.bundlesRoot,
    notFoundMessage: firstPartyViewNotFoundMessage({
      commandLabel: "dome mcp tasks",
      bundleId: "dome.daily",
      processorName: "today",
    }),
    noStructuredResultMessage:
      "dome mcp tasks: today processor returned no structured result.",
  });
}

type BriefSource = {
  readonly date: string;
  readonly path: string;
  readonly exists: boolean;
  readonly commit: string | null;
  readonly counts: unknown;
};

/**
 * Narrow the dome.daily.today/v1 payload to what the brief needs: the
 * config-aware daily path, whether it exists in adopted state, and the
 * adopted commit (from the daily's own source ref) to read it at.
 */
function parseBriefSource(data: unknown): BriefSource {
  const record = asRecord(data);
  const daily = asRecord(record.daily);
  const date = typeof record.date === "string" ? record.date : "";
  const path = typeof daily.path === "string" ? daily.path : "";
  if (date.length === 0 || path.length === 0) {
    throw new Error(
      "dome mcp brief: today view returned no daily date/path.",
    );
  }
  const sourceRefs = Array.isArray(daily.sourceRefs) ? daily.sourceRefs : [];
  const firstRef = asRecord(sourceRefs[0]);
  const commit = typeof firstRef.commit === "string" ? firstRef.commit : null;
  return Object.freeze({
    date,
    path,
    exists: daily.exists === true,
    commit,
    counts: record.counts ?? null,
  });
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

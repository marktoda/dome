// mcp/server: the Dome MCP protocol adapter — wedge Phase 5.
//
// Per docs/wiki/specs/mcp-surface.md, this is a THIN adapter: every tool
// resolves to the same data path the corresponding CLI verb uses, and tool
// results are the same `dome.<verb>/v1` JSON documents the CLI emits under
// `--json`. There is no parallel query/serialization logic here.
//
//   capture        → performCapture          (dome.capture/v1)
//   query          → vault.runView("query")  (dome.search.query/v1)
//   export_context → vault.runView("export-context")
//                                            (dome.search.export-context/v1)
//   report_miss    → reportMiss              (dome.report-miss/v1)
//   status         → buildStatusSnapshot     (status snapshot, stable keys)
//   check          → buildCheckReport        (dome.check/v1)
//   resolve        → vault.resolve           (dome.answer/v1)
//   settle         → performSettle           (dome.settle/v1)
//   tasks          → vault.runView("today")  (dome.daily.today/v1)
//   brief          → today view + adopted-commit blob read
//                                            (dome.mcp.brief/v1)
//
// Boundary notes:
//
//   - Tools consume the public `openVault` wrapper and the CLI's
//     data-returning collectors (`performCapture`, `buildStatusSnapshot`,
//     `buildCheckReport`) directly — nothing prints, so nothing needs the
//     old captured-console plumbing, and stdout stays exclusively the MCP
//     protocol channel.
//   - The tool mutex serializes calls, so at most one VaultRuntime is open
//     at a time. Each call opens and closes its own runtime exactly like
//     one CLI invocation; no long-lived SQLite handle is held.
//   - This module statically imports @modelcontextprotocol/sdk and is a
//     companion entrypoint (`@dome/sdk/mcp`, hosted by `dome mcp`). It must
//     never be imported from the static graph of src/index.ts — pinned by
//     ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY and enforced by
//     tests/integration/bundle-deps.test.ts.
//   - No engine control here: no sync/serve/init/rebuild tools. The daemon
//     owns compilation; `capture`, `resolve`, `settle`, and `report_miss`
//     all reuse existing non-engine write channels (ordinary human commit;
//     answers.db).

import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../surface/answer";
import {
  captureJsonDocument,
  performCapture,
} from "../surface/capture";
import {
  buildCheckReport,
  resolveScopes,
} from "../surface/check";
import { performSettle, settleResultJson } from "../surface/settle";
import { reportMiss, reportMissResultJson } from "../surface/report-miss";
import { buildStatusSnapshot } from "../surface/status";
import {
  catalogViewProblemMessage,
  dispatchView,
  makeVaultMutex,
  openVaultErrorKind,
  runtimeOpenFailureMessage,
  withVault as withVaultShared,
  type ViewRenderer,
} from "../surface/adapter";
import {
  FIRST_PARTY_VIEWS,
  type FirstPartyViewEntry,
} from "../surface/view-catalog";
import { COMMAND_ERROR_SCHEMA } from "../surface/command-error";
import { formatJson } from "../surface/format";
import { DEFAULT_ORPHAN_RUN_THRESHOLD_MS } from "../engine/host/health";
import { readBlob } from "../git";
import type { Vault } from "../vault";

// ----- Constants ------------------------------------------------------------

const SERVER_NAME = "dome";
const SERVER_VERSION = "0.1.0";

const BRIEF_SCHEMA = "dome.mcp.brief/v1";

const DEFAULT_CHECK_LIMIT = 10;

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
- settle: close, defer, or keep a task line by its block anchor.
- query / export_context: adopted-state recall with source refs.
- report_miss: log a retrieval miss when a query/packet missed obvious
  context — feeds the weekly report card's dogfood evidence.
- brief / tasks: today's daily note content and source-backed open loops.

All results are JSON documents matching the CLI's --json schemas.`;

// ----- Public types ---------------------------------------------------------

export type DomeMcpServerOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
};

// ----- Tool result shaping ----------------------------------------------------

type ToolResult = {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
};

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

/**
 * The vault-open failure envelope — the same `dome.command-error/v1`
 * document the CLI's `emitRuntimeOpenFailure` puts on stdout in JSON mode.
 */
function commandErrorResult(command: string, errorKind: string): ToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: formatJson({
          schema: COMMAND_ERROR_SCHEMA,
          status: "error",
          command,
          error: errorKind,
          message: runtimeOpenFailureMessage(`dome ${command}`, errorKind),
        }),
      },
    ],
    isError: true,
  };
}

// ----- The server -------------------------------------------------------------

/**
 * Build the Dome MCP server for one vault. The caller owns the transport:
 * `dome mcp` connects stdio; tests connect an in-memory pair.
 */
export function createDomeMcpServer(opts: DomeMcpServerOptions): McpServer {
  const vault = opts.vaultPath;
  const bundlesRoot = opts.bundlesRoot;
  const enqueue = makeVaultMutex();

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /**
   * Open the vault, run `fn`, and always close — the per-call lifecycle
   * every runtime-needing tool shares. Open failures render as the CLI's
   * command-error envelope.
   */
  const withVault = async (
    command: string,
    fn: (vault: Vault) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const outcome = await withVaultShared({ path: vault, bundlesRoot }, fn);
    return outcome.kind === "open-failed"
      ? commandErrorResult(command, openVaultErrorKind(outcome.error))
      : outcome.value;
  };

  /** The MCP error-rendering seam: open failures + view problems → tool errors. */
  const mcpViewRenderer = <TPayload>(
    toolLabel: string,
    entry: FirstPartyViewEntry<TPayload>,
  ): ViewRenderer<ToolResult> => ({
    openFailed: (error) =>
      commandErrorResult(toolLabel, openVaultErrorKind(error)),
    problem: (problem) =>
      errorToolResult([catalogViewProblemMessage(toolLabel, entry, problem)]),
  });

  /**
   * Run a catalog view through the shared `dispatchView` core. Keeps the
   * `{ kind: "ok" } | { kind: "error" }` shape the tool handlers already branch
   * on; the open-use-close + validation + problem rendering live in the core.
   */
  const structuredViewResult = async <TPayload>(input: {
    readonly toolLabel: string;
    readonly entry: FirstPartyViewEntry<TPayload>;
    readonly args: unknown;
  }): Promise<
    | { readonly kind: "ok"; readonly data: TPayload }
    | { readonly kind: "error"; readonly result: ToolResult }
  > => {
    const run = await dispatchView(
      { path: vault, bundlesRoot },
      input.entry,
      input.args,
      mcpViewRenderer(input.toolLabel, input.entry),
    );
    return run.kind === "rendered"
      ? { kind: "error", result: run.envelope }
      : { kind: "ok", data: run.data };
  };

  // ----- capture ---------------------------------------------------------------

  server.registerTool(
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
    async ({ text, title }) =>
      enqueue(async () => {
        const outcome = await performCapture({
          text,
          ...(title !== undefined ? { title } : {}),
          vault,
        });
        return {
          ...jsonToolResult(captureJsonDocument(outcome)),
          ...(outcome.kind === "error" ? { isError: true } : {}),
        };
      }),
  );

  // ----- query / export_context --------------------------------------------------

  server.registerTool(
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
    async ({ text, limit, category, type }) =>
      enqueue(async () => {
        const run = await structuredViewResult({
          toolLabel: "dome mcp query",
          entry: FIRST_PARTY_VIEWS.query,
          args: Object.freeze({
            text,
            ...(category !== undefined ? { category } : {}),
            ...(type !== undefined ? { type } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        });
        return run.kind === "error" ? run.result : jsonToolResult(run.data);
      }),
  );

  server.registerTool(
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
    async ({ topic, limit }) =>
      enqueue(async () => {
        const run = await structuredViewResult({
          toolLabel: "dome mcp export_context",
          entry: FIRST_PARTY_VIEWS.exportContext,
          args: Object.freeze({
            topic,
            ...(limit !== undefined ? { limit } : {}),
          }),
        });
        return run.kind === "error" ? run.result : jsonToolResult(run.data);
      }),
  );

  // ----- report_miss -----------------------------------------------------------

  server.registerTool(
    "report_miss",
    {
      title: "Log a retrieval miss",
      description:
        "Append one dated entry to meta/retrieval-misses.md — the dogfood " +
        "evidence base retrieval-quality work (banked embeddings) is gated " +
        "on. Call this when a `query`/`export_context` result missed " +
        "obvious context instead of just telling the user. One ordinary " +
        "human commit (`miss: <query first 40 chars>`); never talks to the " +
        "engine. Returns the dome.report-miss/v1 JSON payload.",
      inputSchema: {
        query: z.string().min(1).describe(
          "The query or topic that missed.",
        ),
        note: z.string().optional().describe(
          "What was missing. Defaults to 'no note'.",
        ),
      },
    },
    async ({ query, note }) =>
      enqueue(async () => {
        const outcome = await reportMiss(vault, { query, note });
        return {
          ...jsonToolResult(reportMissResultJson(outcome)),
          ...(outcome.status === "recorded" ? {} : { isError: true }),
        };
      }),
  );

  // ----- status / check -----------------------------------------------------------

  server.registerTool(
    "status",
    {
      title: "Vault status pulse",
      description:
        "Read-only vault dashboard: git cursor, attention codes, " +
        "next_actions, serve/daemon state, content analytics, and " +
        "operational counts. Same stable-key JSON as `dome status --json`.",
      inputSchema: {},
    },
    async () =>
      enqueue(async () => {
        const outcome = await buildStatusSnapshot({ vault, bundlesRoot });
        return outcome.kind === "runtime-open-failed"
          ? commandErrorResult("status", outcome.errorKind)
          : jsonToolResult(outcome.snapshot);
      }),
  );

  server.registerTool(
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
    async ({ engine, content, decisions, attention, limit }) =>
      enqueue(async () => {
        const outcome = await buildCheckReport({
          vault,
          bundlesRoot,
          scopes: resolveScopes({ engine, content, decisions }),
          attentionOnly: attention === true,
          limit: limit ?? DEFAULT_CHECK_LIMIT,
          orphanThresholdMs: DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
        });
        return outcome.kind === "runtime-open-failed"
          ? commandErrorResult("check", outcome.errorKind)
          : jsonToolResult(outcome.report);
      }),
  );

  // ----- resolve -------------------------------------------------------------------

  server.registerTool(
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
    async ({ id, value }) =>
      enqueue(() =>
        withVault("resolve", async (v) => {
          const trimmed = value?.trim();
          if (trimmed === undefined || trimmed.length === 0) {
            const record = await v.getQuestion(id);
            if (record === null) return questionNotFoundResult(id);
            return jsonToolResult({
              schema: ANSWER_SCHEMA,
              ...questionRecordJson(record),
            });
          }

          const outcome = await v.resolve(id, trimmed);
          switch (outcome.kind) {
            case "not-found":
              return questionNotFoundResult(id);
            case "invalid-option":
              return {
                ...jsonToolResult({
                  schema: ANSWER_SCHEMA,
                  status: "invalid-option",
                  options: outcome.options,
                  question: questionRecordJson(outcome.record),
                }),
                isError: true,
              };
            case "answered":
            case "already-answered":
              return jsonToolResult({
                schema: ANSWER_SCHEMA,
                status: outcome.kind,
                question: questionRecordJson(outcome.record),
                handlers:
                  outcome.handlers === null
                    ? null
                    : answerHandlersJson(outcome.handlers),
              });
          }
        }),
      ),
  );

  // ----- settle --------------------------------------------------------------------

  server.registerTool(
    "settle",
    {
      title: "Settle a task line by its block anchor",
      description:
        "Apply a close / defer / keep disposition to a task line located by " +
        "its `^block-anchor` — the decision op behind `dome settle`. `close` " +
        "checks the box and records a Done-today bullet in today's daily; " +
        "`defer` rewrites the due date to `deferUntil`; `keep` settles " +
        "without writing anything. One ordinary human commit (none for " +
        "`keep`). Returns the dome.settle/v1 JSON payload.",
      inputSchema: {
        blockId: z.string().min(1).describe(
          "The task line's `^block-anchor` id.",
        ),
        disposition: z.enum(["close", "defer", "keep"]).describe(
          "close | defer | keep.",
        ),
        deferUntil: z.string().optional().describe(
          "YYYY-MM-DD; required iff disposition is defer.",
        ),
      },
    },
    async ({ blockId, disposition, deferUntil }) =>
      enqueue(async () => {
        const outcome = await performSettle(vault, {
          blockId,
          disposition,
          deferUntil,
        });
        return {
          ...jsonToolResult(settleResultJson(outcome)),
          ...(outcome.status === "settled" ? {} : { isError: true }),
        };
      }),
  );

  // ----- tasks / brief ---------------------------------------------------------------

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
      enqueue(async () => {
        const run = await todayView({ date, limit });
        return run.kind === "error" ? run.result : jsonToolResult(run.data);
      }),
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
      enqueue(async () => {
        const run = await todayView({ date });
        if (run.kind === "error") return run.result;
        const source = parseBriefSource(run.data);
        const content =
          source.exists && source.commit !== null
            ? await readBlob({
                path: vault,
                commit: source.commit,
                filepath: source.path,
              })
            : null;
        return jsonToolResult({
          schema: BRIEF_SCHEMA,
          date: source.date,
          path: source.path,
          exists: source.exists,
          content,
          counts: source.counts,
        });
      }),
  );

  /** Dispatch the `today` view with the shared structured-view validation. */
  const todayView = (input: {
    readonly date?: string | undefined;
    readonly limit?: number | undefined;
  }) =>
    structuredViewResult({
      toolLabel: "dome mcp tasks",
      // Lenient degrade: the tasks tool surfaces the daily view to an agent
      // and should render even a slightly-off payload, so it overrides the
      // strict contract here (parity with the CLI/HTTP today surfaces).
      entry: { ...FIRST_PARTY_VIEWS.today, payload: z.unknown() },
      args: Object.freeze({
        ...(input.date !== undefined ? { date: input.date } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    });

  return server;
}

// ----- internals --------------------------------------------------------------

function questionNotFoundResult(id: number): ToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: formatJson({
          schema: ANSWER_SCHEMA,
          status: "error",
          error: "question-not-found",
          message: `dome resolve: question ${id} was not found.`,
        }),
      },
    ],
    isError: true,
  };
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
  // Validate against the shared dome.daily.today/v1 contract — now sourced
  // from the catalog entry (the single declaration) rather than importing the
  // schema directly. A malformed/absent payload falls through to the empty
  // date/path guard below (same behavior as before).
  const parsed = FIRST_PARTY_VIEWS.today.payload.safeParse(data);
  const payload = parsed.success ? parsed.data : null;
  const date = payload?.date ?? "";
  const daily = payload?.daily;
  const path = daily?.path ?? "";
  if (date.length === 0 || path.length === 0) {
    throw new Error(
      "dome mcp brief: today view returned no daily date/path.",
    );
  }
  const commit = daily?.sourceRefs?.[0]?.commit ?? null;
  return Object.freeze({
    date,
    path,
    exists: daily?.exists === true,
    commit,
    counts: payload?.counts ?? null,
  });
}

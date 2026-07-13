// src/assistant/tools.ts
//
// Vault tools for the agent backend, expressed as a Vercel AI SDK
// tool set (Record<string, Tool>). The AI SDK runs each tool's `execute` during
// streamText(), so citations are accumulated into a shared array provided by
// the built-in AgentRuntime adapter and read after the turn completes.
//
// Wraps the Vault handle's two recall entry-points:
//   vault.runView(command, input) — any installed plugin view
//   vault.readDocument(path)      — full document content
//
// Beyond recall, the assistant speaks the same contract operations as the
// HTTP routes and MCP tools — thin wrappers over the shared src/surface/
// collectors, gated by the same capability vocabulary ROUTE_CAPABILITY uses
// (src/http/server.ts):
//
//   capture_note     capture  → performCapture     (dome.capture/v1)
//   settle_task      resolve  → performSettle      (dome.settle/v1)
//   resolve_question resolve  → vault.resolve      (dome.answer/v1)
//   list_agent_work  read     → vault.agentWork    (dome.agent-work/v1)
//   complete_agent_work resolve → vault.completeAgentWork
//   list_proposals   read     → collectProposals   (dome.proposals/v1)
//   apply_proposal   resolve  → performApply       (dome.apply/v1)
//   reject_proposal  resolve  → performReject      (dome.reject/v1)
//   create_document  author   → createDocument     (agent write path)
//   edit_document    author   → editDocument       (agent write path)
//
// Each tool returns the collector's JSON document as a string; mutating
// tools additionally push one AgentChange into the shared `changes` array
// (the PWA change display + agent-log contract).
//
// The agent deliberately knows no first-party view names or payload shapes.
// `run_view` discovers commands from Vault.listViews(), invokes the generic
// Vault.runView seam, returns each ViewEffect in a stable JSON envelope, and
// records citations from ViewEffect.scope. Plugins therefore extend agent
// recall without requiring another assistant-specific adapter.

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Vault } from "../vault";
import type { Citation, AgentChange } from "./types";
import { commitOid, sourceRef } from "../core/source-ref";
import {
  createDocumentMutation,
  editDocumentMutation,
  validateCreateDocument,
  validateEditDocument,
  type AgentWriteMutationOutcome,
} from "./write";
import { has, type Capability } from "../capabilities";
import type { AssistantMutationExecutor, AuthenticatedMutationActor } from "../request-receipts/assistant-mutation-executor";
import type { FinishRequestReceiptInput, RequestReceiptOperation, RequestReceiptOperationClass } from "../request-receipts/request-receipts";
import { captureJsonDocument, performCapture } from "../surface/capture";
import { runInstalledView } from "../surface/run-view";
import { performSettle, settleResultJson } from "../surface/settle";
import {
  applyResultJson,
  collectProposals,
  performApply,
  performReject,
  proposalsJson,
  rejectResultJson,
} from "../surface/proposals";
import {
  ANSWER_SCHEMA,
  answerHandlersJson,
  questionRecordJson,
} from "../surface/answer";

// ----- helpers ----------------------------------------------------------------

function recordCitation(citations: Citation[], c: Citation): void {
  if (!citations.some((x) => x.path === c.path)) citations.push(c);
}

async function renderViewResult(
  vault: Vault,
  command: string,
  input: Record<string, unknown>,
  citations: Citation[],
): Promise<string> {
  const result = await runInstalledView(vault, command, input);
  if (result.status === "ok") {
    for (const view of result.views) {
      for (const ref of view.scope) {
      recordCitation(citations, { path: ref.path, commit: ref.commit });
      }
    }
  }
  return JSON.stringify(result, null, 2);
}

// ----- public API -------------------------------------------------------------

/**
 * Action context for the contract + write tools. `capabilities` is the same
 * granted set the HTTP routes gate on (the server passes it through
 * runAgentStream): `capture` provisions capture_note, `resolve`
 * provisions settle_task/resolve_question/apply_proposal/reject_proposal,
 * `read` provisions list_proposals, and `author` provisions
 * create_document/edit_document. Mutating tools push each successful
 * operation into `changes`. When no context is given, only the two recall
 * tools are provisioned.
 */
export type AgentActionContext = {
  readonly vaultPath: string;
  readonly modelId: string;
  readonly changes: AgentChange[];
  readonly capabilities: ReadonlySet<Capability>;
  readonly mutationActor?: AuthenticatedMutationActor | undefined;
  readonly mutationExecutor?: AssistantMutationExecutor | undefined;
  readonly signal?: AbortSignal | undefined;
};

export function agentWriteReceiptTerminal(outcome: AgentWriteMutationOutcome): FinishRequestReceiptInput {
  if (outcome.kind === "committed") {
    return { state: "succeeded", resultCode: outcome.change.kind === "create" ? "created" : "edited", commitOid: outcome.commit };
  }
  if (outcome.kind === "rejected") return { state: "rejected", resultCode: outcome.code };
  return outcome.commit === null
    ? { state: "interrupted", resultCode: "mutation-outcome-unknown", adoptionState: "unknown", recoveryRequired: true }
    : { state: "succeeded", resultCode: "committed-recovery-required", commitOid: outcome.commit, recoveryRequired: true };
}

/**
 * Build the AI SDK tool set for the ask agent. Citations gathered during tool
 * execution are pushed into the shared `citations` array (read by AgentRuntime
 * after the provider stream drains).
 */
export function buildAgentTools(
  vault: Vault,
  citations: Citation[],
  action?: AgentActionContext | undefined,
): ToolSet {
  const tools: ToolSet = {
    run_view: tool({
      description:
        "Run any installed read-only Dome plugin view against adopted vault state. Use the installed command names supplied in the system prompt. Returns a stable JSON envelope and records every source in the view's scope.",
      inputSchema: z.object({
        command: z.string().describe("An installed view command, such as query or today."),
        input: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The view's command-specific input object."),
      }),
      execute: async (input) => {
        const command = typeof input.command === "string" ? input.command.trim() : "";
        if (command.length === 0) {
          return "error: run_view requires non-empty `command`.";
        }
        return renderViewResult(vault, command, input.input ?? {}, citations);
      },
    }),
    read_document: tool({
      description:
        "Read the full markdown of a vault page by path. Use for a known path and to inspect sources returned by run_view before important claims or edits.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Vault-relative path, e.g. wiki/entities/x.md."),
      }),
      execute: async (input) => {
        const path = typeof input.path === "string" ? input.path : "";
        if (path.trim().length === 0) {
          return "error: read_document requires `path`.";
        }
        const doc = await vault.readDocument(path);
        if (doc === null) {
          return `not found: no adopted document at '${path}'.`;
        }
        recordCitation(citations, { path: doc.path, commit: doc.commit });
        return doc.content;
      },
    }),
  };

  if (action === undefined) return tools;

  // Serialize a collector's JSON document as the tool result, recording a
  // change entry when the operation actually landed. Mirrors the MCP tools:
  // the doc itself carries the status; failures come back as documents, not
  // throws (a failed operation must not crash the agent loop).
  const jsonResult = (
    doc: Record<string, unknown>,
    change?: AgentChange | undefined,
  ): string => {
    if (change !== undefined) action.changes.push(change);
    return JSON.stringify(doc, null, 2);
  };
  const runMutation = async <T>(
    operation: RequestReceiptOperation,
    operationClass: RequestReceiptOperationClass,
    mutate: (signal: AbortSignal) => Promise<{ value: T; terminal: FinishRequestReceiptInput }>,
  ): Promise<T> => {
    if (action.mutationActor === undefined && action.mutationExecutor === undefined) {
      return (await mutate(action.signal ?? new AbortController().signal)).value;
    }
    if (action.mutationActor === undefined || action.mutationExecutor === undefined) {
      throw new Error("assistant mutation identity/executor pair is incomplete");
    }
    return action.mutationExecutor.execute({
      actor: action.mutationActor,
      operation,
      operationClass,
      mutate,
      ...(action.signal !== undefined ? { signal: action.signal } : {}),
    });
  };

  if (has(action.capabilities, "capture")) {
    tools["capture_note"] = tool({
      description:
        "Capture a thought into the vault inbox: writes inbox/raw/<stamp>-<slug>.md and commits exactly that one file. Use when the owner wants to save a note, idea, or reminder. Returns the dome.capture/v1 JSON document with the created path.",
      inputSchema: z.object({
        text: z.string().describe("Capture body (markdown or plain text)."),
        title: z
          .string()
          .optional()
          .describe("Optional explicit title; drives the filename slug and commit message."),
      }),
      execute: async (input) => {
        if (input.text.trim().length === 0) return jsonResult({
          schema: "dome.capture/v1", status: "error", error: "capture_note requires non-empty text",
        });
        const outcome = await runMutation("capture", "workspace-mutation", async () => {
          const value = await performCapture({
            text: input.text,
            ...(input.title !== undefined ? { title: input.title } : {}),
            vault: action.vaultPath,
            source: "assistant",
          });
          if (value.kind === "error" && value.exitCode !== 64) throw new Error("capture outcome unknown");
          return {
            value,
            terminal: value.kind === "captured"
              ? { state: "succeeded", resultCode: "captured", commitOid: value.result.commit }
              : value.kind === "duplicate"
                ? { state: "succeeded", resultCode: "duplicate" }
                : { state: "rejected", resultCode: "capture-invalid" },
          };
        });
        return jsonResult(
          captureJsonDocument(outcome),
          outcome.kind === "captured"
            ? { path: outcome.result.path, kind: "capture" }
            : undefined,
        );
      },
    });
  }

  if (has(action.capabilities, "resolve")) {
    tools["settle_task"] = tool({
      description:
        "Settle a task line located by its ^block-anchor id: close checks the box and records a Done-today bullet, defer rewrites the due date to deferUntil, keep settles without writing. Never invent an anchor — obtain it from an installed view or source document first. Returns the dome.settle/v1 JSON document.",
      inputSchema: z.object({
        blockId: z.string().describe("The task line's ^block-anchor id (without the caret)."),
        disposition: z.enum(["close", "defer", "keep"]).describe("close | defer | keep."),
        deferUntil: z
          .string()
          .optional()
          .describe("YYYY-MM-DD; required iff disposition is defer."),
      }),
      execute: async (input) => {
        if (input.blockId.trim().length === 0 || (input.disposition === "defer" && !/^\d{4}-\d{2}-\d{2}$/.test(input.deferUntil ?? ""))) {
          return jsonResult({ schema: "dome.settle/v1", status: "invalid", message: "invalid settle input" });
        }
        const outcome = await runMutation("settle", "workspace-mutation", async () => {
          const value = await performSettle(action.vaultPath, {
            blockId: input.blockId,
            disposition: input.disposition,
            ...(input.deferUntil !== undefined ? { deferUntil: input.deferUntil } : {}),
          });
          if (value.status === "invalid") throw new Error("settle outcome unknown");
          return {
            value,
            terminal: value.status === "settled"
              ? { state: "succeeded", resultCode: value.commit === undefined ? "settled-noop" : "settled", ...(value.commit !== undefined ? { commitOid: value.commit } : {}) }
              : { state: "rejected", resultCode: "not-found" },
          };
        });
        return jsonResult(
          settleResultJson(outcome),
          outcome.status === "settled" && outcome.commit !== undefined
            ? { path: `^${input.blockId}`, kind: "settle" }
            : undefined,
        );
      },
    });

    tools["resolve_question"] = tool({
      description:
        "Answer a Dome-raised question by its numeric id. Never invent an id — obtain it from an installed view or source document first. Returns the dome.answer/v1 JSON document.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Question id."),
        value: z.string().describe("The decision value (one of the question's options, when listed)."),
      }),
      execute: async (input) => {
        const value = input.value.trim();
        if (value.length === 0) {
          return jsonResult({
            schema: ANSWER_SCHEMA,
            status: "error",
            error: "resolve-usage",
            message: "resolve_question requires a non-empty `value`.",
          });
        }
        const outcome = await runMutation("resolve", "operational-transaction", async () => {
          const result = await vault.resolve(input.id, value);
          return {
            value: result,
            terminal: result.kind === "answered" || result.kind === "already-answered"
              ? { state: "succeeded", resultCode: result.kind }
              : { state: "rejected", resultCode: result.kind },
          };
        });
        switch (outcome.kind) {
          case "not-found":
            return jsonResult({
              schema: ANSWER_SCHEMA,
              status: "error",
              error: "question-not-found",
              message: `question ${input.id} was not found.`,
            });
          case "invalid-option":
            return jsonResult({
              schema: ANSWER_SCHEMA,
              status: "invalid-option",
              options: outcome.options,
              question: questionRecordJson(outcome.record),
            });
          case "answered":
          case "already-answered":
            return jsonResult(
              {
                schema: ANSWER_SCHEMA,
                status: outcome.kind,
                question: questionRecordJson(outcome.record),
                handlers:
                  outcome.handlers === null
                    ? null
                    : answerHandlersJson(outcome.handlers),
              },
              outcome.kind === "answered"
                ? { path: `question:${input.id}`, kind: "resolve" }
                : undefined,
            );
        }
      },
    });

    tools["complete_agent_work"] = tool({
      description:
        "Complete one ready agent-work packet after reading EVERY required evidence path during this turn. Uses only citations actually gathered by read_document/run_view, validates the packet revision and allowed answer, records agent provenance, and dispatches the existing answer handler.",
      inputSchema: z.object({
        questionId: z.number().int().positive(),
        expectedRevision: z.string().min(1),
        answer: z.string().min(1),
        reason: z.string().min(1).describe(
          "Short explanation of why the inspected evidence supports the answer.",
        ),
      }),
      execute: async (input) => {
        const evidence = citations.flatMap((citation) =>
          citation.commit === undefined
            ? []
            : [sourceRef({
                path: citation.path,
                commit: commitOid(citation.commit),
              })]
        );
        const outcome = await runMutation("agent-work-complete", "operational-transaction", async () => {
          const result = await vault.completeAgentWork({
            questionId: input.questionId,
            expectedRevision: input.expectedRevision,
            answer: input.answer,
            reason: input.reason,
            evidence,
          });
          return {
            value: result,
            terminal: result.kind === "completed" || result.kind === "already-completed"
              ? { state: "succeeded", resultCode: result.kind }
              : { state: "rejected", resultCode: result.kind },
          };
        });
        if (outcome.kind === "not-found") {
          return jsonResult({
            schema: "dome.agent-work-completion/v1",
            status: "not-found",
            questionId: input.questionId,
          });
        }
        if (outcome.kind === "rejected") {
          return jsonResult({
            schema: "dome.agent-work-completion/v1",
            status: "rejected",
            problem: outcome.problem,
            message: outcome.message,
          });
        }
        return jsonResult(
          {
            schema: "dome.agent-work-completion/v1",
            status: outcome.kind,
            question: questionRecordJson(outcome.record),
            handlers: outcome.handlers === null
              ? null
              : answerHandlersJson(outcome.handlers),
          },
          outcome.kind === "completed"
            ? { path: `question:${input.questionId}`, kind: "resolve" }
            : undefined,
        );
      },
    });

    tools["apply_proposal"] = tool({
      description:
        "Apply a pending garden-proposed edit by id (ids come from list_proposals) as one ordinary commit. Fails if the proposal is not pending or has gone stale. Returns the dome.apply/v1 JSON document.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Proposal id from list_proposals."),
      }),
      execute: async (input) => {
        const outcome = await runMutation("apply-proposal", "workspace-mutation", async () => {
          const value = await performApply(action.vaultPath, input.id);
          if (value.status === "invalid") throw new Error("apply outcome unknown");
          return {
            value,
            terminal: value.status === "applied"
              ? { state: "succeeded", resultCode: value.commit === undefined ? "applied-noop" : "applied", ...(value.commit !== undefined ? { commitOid: value.commit } : {}), ...(value.recoveryRequired === true ? { recoveryRequired: true } : {}) }
              : { state: "rejected", resultCode: value.status },
          };
        });
        return jsonResult(
          applyResultJson(outcome),
          outcome.status === "applied"
            ? { path: `proposal:${input.id}`, kind: "apply" }
            : undefined,
        );
      },
    });

    tools["reject_proposal"] = tool({
      description:
        "Reject a pending garden-proposed edit by id (ids come from list_proposals); touches no files. Optional note records why. Returns the dome.reject/v1 JSON document.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Proposal id from list_proposals."),
        note: z.string().optional().describe("Optional note recording why."),
      }),
      execute: async (input) => {
        const outcome = await runMutation("reject-proposal", "operational-transaction", async () => {
          const value = await performReject(action.vaultPath, input.id, input.note);
          return {
            value,
            terminal: value.status === "rejected"
              ? { state: "succeeded", resultCode: "proposal-rejected" }
              : { state: "rejected", resultCode: value.status },
          };
        });
        return jsonResult(
          rejectResultJson(outcome),
          outcome.status === "rejected"
            ? { path: `proposal:${input.id}`, kind: "reject" }
            : undefined,
        );
      },
    });
  }

  if (has(action.capabilities, "read")) {
    tools["list_agent_work"] = tool({
      description:
        "List open questions assigned to agents. Ready packets include a revision, allowed options, and every evidence path that must be read before complete_agent_work. Acknowledgements and evidence-free rows remain visible but are not automatically completable.",
      inputSchema: z.object({
        limit: z.number().int().positive().max(100).optional(),
        questionId: z.number().int().positive().optional(),
      }),
      execute: async (input) =>
        jsonResult(await vault.agentWork({
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.questionId !== undefined
            ? { questionId: input.questionId }
            : {}),
        }) as unknown as Record<string, unknown>),
    });

    tools["list_proposals"] = tool({
      description:
        "List garden-proposed edits awaiting owner review (pending by default; set all for decided rows too). Use before apply_proposal / reject_proposal to get real ids. Returns the dome.proposals/v1 JSON document.",
      inputSchema: z.object({
        all: z
          .boolean()
          .optional()
          .describe("Include applied/rejected rows too (default: pending only)."),
      }),
      execute: async (input) =>
        jsonResult(
          proposalsJson(
            await collectProposals(
              action.vaultPath,
              input.all !== undefined ? { all: input.all } : {},
            ),
          ),
        ),
    });
  }

  if (has(action.capabilities, "author")) {
    // Run a write op, record the change, and surface failures to the model as
    // an `error: …` string (never throw — a rejected write must not crash the loop).
    const runWrite = async (
      operation: "create-document" | "edit-document",
      op: () => Promise<AgentWriteMutationOutcome>,
      verb: "created" | "edited",
    ): Promise<string> => {
      try {
        const outcome = await runMutation(operation, "workspace-mutation", async () => {
          const value = await op();
          return {
            value,
            terminal: agentWriteReceiptTerminal(value),
          };
        });
        if (outcome.kind !== "committed") return `error: ${outcome.message}`;
        action.changes.push(outcome.change);
        return `${verb} ${outcome.change.path}`;
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    };

    tools["create_document"] = tool({
      description:
        "Create a NEW markdown page in the vault and commit it. Fails if the path already exists — use edit_document for an existing page. Path is vault-relative (e.g. wiki/notes/foo.md), .md only; .dome/ is off-limits.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path for the new page."),
        content: z.string().describe("Full markdown content of the new page."),
      }),
      execute: async (input) => {
        if (input.path.trim().length === 0 || input.content.length === 0) return "error: path and content are required";
        try { await validateCreateDocument(action, input); } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        return runWrite("create-document", () => createDocumentMutation(
          action,
          { path: input.path, content: input.content },
        ), "created");
      },
    });
    tools["edit_document"] = tool({
      description:
        "Edit an existing vault page by replacing an exact, UNIQUE substring, then commit. old_string must appear exactly once — include enough surrounding context to be unique. Use to check off a task ('- [ ]' → '- [x]'), fix a line, etc.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative .md path of the page to edit."),
        old_string: z.string().describe("Exact text to replace; must be unique in the file."),
        new_string: z.string().describe("Replacement text."),
      }),
      execute: async (input) => {
        if (input.path.trim().length === 0 || input.old_string.length === 0) return "error: path and old_string are required";
        try { await validateEditDocument(action, input); } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        return runWrite(
          "edit-document",
          () =>
            editDocumentMutation(action, {
              path: input.path,
              old_string: input.old_string,
              new_string: input.new_string,
            }),
          "edited",
        );
      },
    });
  }

  return tools;
}

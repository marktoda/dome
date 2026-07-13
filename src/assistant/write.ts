// src/assistant/write.ts
//
// The hosted agent's vault write path. Mirrors `dome capture`
// (src/surface/capture.ts): one expected-byte controlled mutation lands an
// ordinary human commit; the running daemon adopts the resulting branch drift,
// so PROPOSALS_ARE_THE_ONLY_WRITE_PATH holds. `Dome-Agent: <model>` and the
// mutation Module's `Dome-Request` trailer provide attribution (neither
// classifies the commit as engine-authored).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { currentBranch } from "../git";
import {
  applyControlledMutation,
  type ControlledMutationResult,
} from "../mutation/controlled-mutation";
import { DEFAULT_AGENT_WRITE_SCOPE, writeScopeDenial, type WriteScope } from "../write-scope";
import type { AgentChange } from "./types";

/** Attribution trailer key; NOT part of DOME_TRAILER_KEYS (engine Dome-Run family). */
export const AGENT_TRAILER_KEY = "Dome-Agent";

const AGENT_COMMIT_AUTHOR = { name: "dome agent", email: "dome-agent@local" } as const;

/** A rejected/failed write the tool layer surfaces to the model as prose. */
export class AgentWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentWriteError";
  }
}

/** Validate + normalize a caller-supplied path to a safe vault-relative `.md` path. */
function vaultRelPath(raw: string, scope: WriteScope): string {
  const rel = typeof raw === "string" ? raw.trim() : "";
  if (rel.length === 0) throw new AgentWriteError("path is required");
  if (isAbsolute(rel)) throw new AgentWriteError("path must be vault-relative, not absolute");
  const norm = normalize(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    throw new AgentWriteError(`path escapes the vault: ${raw}`);
  }
  if (norm.split("/")[0] === ".dome") {
    throw new AgentWriteError(".dome/ is engine-internal and off-limits to the agent");
  }
  if (norm.startsWith("inbox/raw/")) {
    throw new AgentWriteError("inbox/raw/ is immutable (RAW_IS_IMMUTABLE); the agent cannot write raw capture files");
  }
  if (!norm.endsWith(".md")) {
    throw new AgentWriteError("only markdown (.md) files can be written");
  }
  const denial = writeScopeDenial(norm, scope);
  if (denial !== null) throw new AgentWriteError(denial);
  return norm;
}

function commitMessage(verb: "create" | "edit", rel: string, modelId: string): string {
  return `author: ${verb} ${rel}\n\n${AGENT_TRAILER_KEY}: ${modelId}`;
}

function mutationRequestId(input: {
  readonly verb: "create" | "edit";
  readonly rel: string;
  readonly modelId: string;
  readonly expectedContent: string | null;
  readonly content: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 32);
  return `agent-write:${input.verb}:${digest}`;
}

export type AgentWriteCtx = {
  readonly vaultPath: string;
  readonly modelId: string;
  readonly scope?: WriteScope;
};

export type AgentWriteMutationOutcome =
  | { readonly kind: "committed"; readonly change: AgentChange; readonly commit: string }
  | { readonly kind: "rejected"; readonly code: string; readonly message: string }
  | { readonly kind: "interrupted"; readonly commit: string | null; readonly message: string };

/** Pre-admission validation; mutation functions repeat checks to close races. */
export async function validateCreateDocument(
  ctx: AgentWriteCtx,
  input: { path: string; content: string },
): Promise<void> {
  const rel = vaultRelPath(input.path, ctx.scope ?? DEFAULT_AGENT_WRITE_SCOPE);
  if (existsSync(join(ctx.vaultPath, rel))) throw new AgentWriteError(`already exists: ${rel} (use edit_document to change it)`);
  if (typeof input.content !== "string" || input.content.length === 0) throw new AgentWriteError("content is required");
  await requireBranch(ctx.vaultPath);
}

export async function validateEditDocument(
  ctx: AgentWriteCtx,
  input: { path: string; old_string: string; new_string: string },
): Promise<void> {
  const rel = vaultRelPath(input.path, ctx.scope ?? DEFAULT_AGENT_WRITE_SCOPE);
  const abs = join(ctx.vaultPath, rel);
  if (!existsSync(abs)) throw new AgentWriteError(`not found: ${rel} (use create_document for a new page)`);
  if (typeof input.old_string !== "string" || input.old_string.length === 0) throw new AgentWriteError("old_string is required");
  if (typeof input.new_string !== "string") throw new AgentWriteError("new_string is required");
  const current = await readFile(abs, "utf8");
  const first = current.indexOf(input.old_string);
  if (first === -1) throw new AgentWriteError(`old_string not found in ${rel}`);
  if (current.indexOf(input.old_string, first + 1) !== -1) throw new AgentWriteError(`old_string is not unique in ${rel}; add more surrounding context`);
  await requireBranch(ctx.vaultPath);
}

export async function createDocument(
  ctx: AgentWriteCtx,
  input: { path: string; content: string },
): Promise<AgentChange> {
  return unwrapWriteOutcome(await createDocumentMutation(ctx, input));
}

export async function createDocumentMutation(
  ctx: AgentWriteCtx,
  input: { path: string; content: string },
): Promise<AgentWriteMutationOutcome> {
  try {
    return await createDocumentMutationUnsafe(ctx, input);
  } catch (error) {
    if (error instanceof AgentWriteError) return { kind: "rejected", code: "validation-rejected", message: error.message };
    throw error;
  }
}

async function createDocumentMutationUnsafe(
  ctx: AgentWriteCtx,
  input: { path: string; content: string },
): Promise<AgentWriteMutationOutcome> {
  const rel = vaultRelPath(input.path, ctx.scope ?? DEFAULT_AGENT_WRITE_SCOPE);
  const abs = join(ctx.vaultPath, rel);
  if (existsSync(abs)) {
    throw new AgentWriteError(`already exists: ${rel} (use edit_document to change it)`);
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new AgentWriteError("content is required");
  }
  const branch = await requireBranch(ctx.vaultPath);
  const mutation = await applyControlledMutation({
    vaultPath: ctx.vaultPath,
    branch,
    requestId: mutationRequestId({
      verb: "create",
      rel,
      modelId: ctx.modelId,
      expectedContent: null,
      content: input.content,
    }),
    files: [{ path: rel, expectedContent: null, content: input.content }],
    message: commitMessage("create", rel, ctx.modelId),
    author: AGENT_COMMIT_AUTHOR,
  });
  return writeOutcome(rel, { path: rel, kind: "create" }, mutation);
}

export async function editDocument(
  ctx: AgentWriteCtx,
  input: { path: string; old_string: string; new_string: string },
): Promise<AgentChange> {
  return unwrapWriteOutcome(await editDocumentMutation(ctx, input));
}

export async function editDocumentMutation(
  ctx: AgentWriteCtx,
  input: { path: string; old_string: string; new_string: string },
): Promise<AgentWriteMutationOutcome> {
  try {
    return await editDocumentMutationUnsafe(ctx, input);
  } catch (error) {
    if (error instanceof AgentWriteError) return { kind: "rejected", code: "validation-rejected", message: error.message };
    throw error;
  }
}

async function editDocumentMutationUnsafe(
  ctx: AgentWriteCtx,
  input: { path: string; old_string: string; new_string: string },
): Promise<AgentWriteMutationOutcome> {
  const rel = vaultRelPath(input.path, ctx.scope ?? DEFAULT_AGENT_WRITE_SCOPE);
  const abs = join(ctx.vaultPath, rel);
  if (!existsSync(abs)) {
    throw new AgentWriteError(`not found: ${rel} (use create_document for a new page)`);
  }
  if (typeof input.old_string !== "string" || input.old_string.length === 0) {
    throw new AgentWriteError("old_string is required");
  }
  // An empty new_string is a valid deletion; only a missing/non-string value is rejected.
  if (typeof input.new_string !== "string") {
    throw new AgentWriteError("new_string is required");
  }
  const current = await readFile(abs, "utf8");
  const first = current.indexOf(input.old_string);
  if (first === -1) {
    throw new AgentWriteError(`old_string not found in ${rel}`);
  }
  if (current.indexOf(input.old_string, first + 1) !== -1) {
    throw new AgentWriteError(`old_string is not unique in ${rel}; add more surrounding context`);
  }
  const next =
    current.slice(0, first) + input.new_string + current.slice(first + input.old_string.length);
  const branch = await requireBranch(ctx.vaultPath);
  const mutation = await applyControlledMutation({
    vaultPath: ctx.vaultPath,
    branch,
    requestId: mutationRequestId({
      verb: "edit",
      rel,
      modelId: ctx.modelId,
      expectedContent: current,
      content: next,
    }),
    files: [{ path: rel, expectedContent: current, content: next }],
    message: commitMessage("edit", rel, ctx.modelId),
    author: AGENT_COMMIT_AUTHOR,
  });
  return writeOutcome(rel, { path: rel, kind: "edit" }, mutation);
}

function unwrapWriteOutcome(outcome: AgentWriteMutationOutcome): AgentChange {
  if (outcome.kind === "committed") return outcome.change;
  throw new AgentWriteError(outcome.message);
}

function writeOutcome(
  rel: string,
  change: AgentChange,
  mutation: ControlledMutationResult,
): AgentWriteMutationOutcome {
  switch (mutation.kind) {
    case "committed":
      return { kind: "committed", change, commit: mutation.commit };
    case "busy":
      return { kind: "rejected", code: "mutation-busy", message: "vault mutation lane is busy; retry later" };
    case "diverged":
      return {
        kind: "interrupted",
        commit: mutation.commit,
        message: `authoring requires recovery: ${mutation.commit === null ? "candidate" : `commit ${mutation.commit}`} has checkout divergence at ${mutation.paths.join(", ") || rel}`,
      };
    case "no-commit":
      return {
        kind: "rejected",
        code: mutation.reason,
        message: mutation.reason === "working-tree-conflict"
          ? `document changed before commit: ${mutation.paths.join(", ") || rel}; read it again before editing`
          : mutation.reason === "branch-mismatch"
            ? "branch changed before the authoring commit"
            : "authoring candidate commit did not land",
      };
  }
}

async function requireBranch(vaultPath: string): Promise<string> {
  const branch = await currentBranch(vaultPath);
  if (branch === null) {
    throw new AgentWriteError(
      "detached HEAD: assistant authoring needs a branch; check out a branch first",
    );
  }
  return branch;
}

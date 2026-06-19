// src/agent/write.ts
//
// The hosted agent's vault write path. Mirrors `dome capture` (src/surface/capture.ts):
// write one markdown file into the working tree and land it as an ordinary human
// commit via commitSingleFileOnHead — the running daemon adopts the resulting
// branch drift, so PROPOSALS_ARE_THE_ONLY_WRITE_PATH holds. The only difference
// from capture is the `author:` verb and a single `Dome-Agent: <model>` trailer
// for attribution (deliberately NOT in DOME_TRAILER_KEYS, so the commit stays
// classified human, not engine).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { commitSingleFileOnHead } from "../git";
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
function vaultRelPath(raw: string): string {
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
  if (!norm.endsWith(".md")) {
    throw new AgentWriteError("only markdown (.md) files can be written");
  }
  return norm;
}

function commitMessage(verb: "create" | "edit", rel: string, modelId: string): string {
  return `author: ${verb} ${rel}\n\n${AGENT_TRAILER_KEY}: ${modelId}`;
}

export type AgentWriteCtx = { readonly vaultPath: string; readonly modelId: string };

export async function createDocument(
  ctx: AgentWriteCtx,
  input: { path: string; content: string },
): Promise<AgentChange> {
  const rel = vaultRelPath(input.path);
  const abs = join(ctx.vaultPath, rel);
  if (existsSync(abs)) {
    throw new AgentWriteError(`already exists: ${rel} (use edit_document to change it)`);
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new AgentWriteError("content is required");
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, input.content, "utf8");
  await commitSingleFileOnHead({
    path: ctx.vaultPath,
    filepath: rel,
    content: input.content,
    message: commitMessage("create", rel, ctx.modelId),
    author: AGENT_COMMIT_AUTHOR,
  });
  return { path: rel, kind: "create" };
}

export async function editDocument(
  ctx: AgentWriteCtx,
  input: { path: string; old_string: string; new_string: string },
): Promise<AgentChange> {
  const rel = vaultRelPath(input.path);
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
  await writeFile(abs, next, "utf8");
  await commitSingleFileOnHead({
    path: ctx.vaultPath,
    filepath: rel,
    content: next,
    message: commitMessage("edit", rel, ctx.modelId),
    author: AGENT_COMMIT_AUTHOR,
  });
  return { path: rel, kind: "edit" };
}

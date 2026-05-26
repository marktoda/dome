// Invariant guards shared by mutating Tools (writeDocument, moveDocument,
// deleteDocument). Each guard is a small, single-responsibility helper that
// either returns a ToolError to short-circuit the Tool's body or returns
// null/the expected value when the check passes.
//
// Centralizing these guards closes the structural-duplication finding from
// the substrate-alignment review: prior to this module, RAW_IS_IMMUTABLE,
// the optimistic-locking re-check, and the EVERY_WRITE_IS_LOGGED log append
// were copy-pasted across three Tool files with slight wording drift on each
// error message. The guards live in one place so a future invariant change
// (e.g. an added privileged path) is a one-edit operation.
//
// dispatcher-owned-path is its own helper (refuseIfDispatcherOwned in
// dispatcher.ts) because it depends on the privileged-path catalog living
// next to the dispatcher; nothing to gain from re-homing it here.

import { stat } from "node:fs/promises";
import { makeDocument } from "../document";
import type { Effect, LogEntry, LogVerb, ToolError } from "../types";
import type { Vault } from "../vault";
import type { PrivilegedWriter } from "../privileged-writer";

/**
 * Refuse if `path` lives under `raw/` per RAW_IS_IMMUTABLE (axiom).
 * Returns null when the path is OK to write/move/delete.
 */
export function refuseIfRawImmutable(
  path: string,
  toolName: string,
  detailContext?: string,
): Extract<ToolError, { kind: "invariant-violated" }> | null {
  const doc = makeDocument({ path });
  if (doc.category !== "raw") return null;
  return {
    kind: "invariant-violated",
    invariant: "RAW_IS_IMMUTABLE",
    detail: detailContext
      ? `${toolName} refuses raw/ target; ${detailContext}`
      : `${toolName} refuses raw/ target: ${path}`,
  };
}

/**
 * Optimistic-locking re-check: if `expectedMtime` is set, stat the file and
 * return a concurrent-write-conflict ToolError if the on-disk mtime has
 * drifted. Callers that don't thread expected_mtime (the v0.5 default for
 * single-user workflows) get null and proceed.
 */
export async function checkOptimisticLock(
  absPath: string,
  path: string,
  expectedMtime: string | undefined,
): Promise<Extract<ToolError, { kind: "concurrent-write-conflict" }> | null> {
  if (expectedMtime === undefined) return null;
  const currentStat = await stat(absPath).catch(() => null);
  if (!currentStat) return null;
  const actual = currentStat.mtime.toISOString();
  if (actual === expectedMtime) return null;
  return {
    kind: "concurrent-write-conflict",
    path,
    expected_mtime: expectedMtime,
    actual_mtime: actual,
  };
}

/**
 * Per EVERY_WRITE_IS_LOGGED: when the invariant is enabled in vault config,
 * append a log entry for the mutation and return the resulting Effect.
 * Returns null when the invariant is disabled (so the caller doesn't push
 * an empty effect).
 *
 * The mutating Tools each have their own (verb, subject, body) — this
 * helper only ensures the gate is applied consistently and the dispatcher
 * call shape stays in one place.
 */
export async function logMutation(
  vault: Vault,
  dispatcher: PrivilegedWriter,
  entry: { verb: LogVerb; subject: string; body?: string; refs?: ReadonlyArray<string> },
): Promise<Effect | null> {
  if (vault.config.invariants.EVERY_WRITE_IS_LOGGED !== "enabled") return null;
  const logEntry: LogEntry = {
    ts: new Date().toISOString(),
    verb: entry.verb,
    subject: entry.subject,
    ...(entry.body !== undefined ? { body: entry.body } : {}),
    ...(entry.refs !== undefined ? { refs: entry.refs } : {}),
  };
  return dispatcher.appendLogEntry(logEntry);
}

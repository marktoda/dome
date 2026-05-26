import { unlink, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeDocument } from "../document";
import { ok, err, type Effect, type ToolReturn } from "../types";
import type { Vault } from "../vault";
import { type Dispatcher, refuseIfDispatcherOwned } from "../dispatcher";

export interface DeleteDocumentInput {
  path: string;
  reason: string;
  /**
   * Test-only: pre-seed the mtime snapshot for optimistic locking; production
   * callers leave this unset. @internal
   */
  __forceExpectedMtime?: string;
}

export async function deleteDocument(
  vault: Vault,
  dispatcher: Dispatcher,
  input: DeleteDocumentInput
): Promise<ToolReturn<void>> {
  const ownedErr = refuseIfDispatcherOwned(input.path, "deleteDocument");
  if (ownedErr) return { result: err(ownedErr), effects: [] };
  const doc = makeDocument({ path: input.path });
  if (doc.category === "raw") {
    return {
      result: err({
        kind: "invariant-violated",
        invariant: "RAW_IS_IMMUTABLE",
        detail: `deleteDocument refuses raw/ target: ${input.path}`,
      }),
      effects: [],
    };
  }
  const abs = join(vault.path, input.path);
  try {
    await access(abs);
  } catch {
    return { result: err({ kind: "not-found", path: input.path }), effects: [] };
  }

  // Optimistic locking — snapshot mtime, verify before unlink.
  const expectedMtime = input.__forceExpectedMtime ?? (await stat(abs)).mtime.toISOString();
  const currentStat = await stat(abs).catch(() => null);
  if (currentStat && currentStat.mtime.toISOString() !== expectedMtime) {
    return {
      result: err({
        kind: "concurrent-write-conflict",
        path: input.path,
        expected_mtime: expectedMtime,
        actual_mtime: currentStat.mtime.toISOString(),
      }),
      effects: [],
    };
  }

  await unlink(abs);
  const effects: Effect[] = [];
  if (vault.config.invariants.EVERY_WRITE_IS_LOGGED === "enabled") {
    const e = await dispatcher.appendLogEntry({
      ts: new Date().toISOString(),
      verb: "update",
      subject: `delete ${input.path}`,
      body: input.reason,
    });
    effects.push(e);
  }
  return { result: ok(undefined), effects };
}

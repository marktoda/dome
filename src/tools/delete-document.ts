import { unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { makeDocument } from "../document";
import { ok, err, type Effect, type ToolReturn } from "../types";
import type { Vault } from "../vault";
import type { Dispatcher } from "../dispatcher";

export interface DeleteDocumentInput {
  path: string;
  reason: string;
}

export async function deleteDocument(
  vault: Vault,
  dispatcher: Dispatcher,
  input: DeleteDocumentInput
): Promise<ToolReturn<void>> {
  if (input.path === "index.md" || input.path === "log.md") {
    return {
      result: err({ kind: "dispatcher-owned-path", path: input.path, requested_tool: "deleteDocument" }),
      effects: [],
    };
  }
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

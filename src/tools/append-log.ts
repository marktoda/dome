import type { Vault } from "../vault";
import type { PrivilegedWriter } from "../privileged-writer";
import { ok, type LogEntry, type LogVerb, type ToolReturn } from "../types";

export interface AppendLogInput {
  verb: LogVerb;
  subject: string;
  body?: string;
  refs?: ReadonlyArray<string>;
}

export async function appendLog(
  _vault: Vault,
  dispatcher: PrivilegedWriter,
  input: AppendLogInput
): Promise<ToolReturn<LogEntry>> {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    verb: input.verb,
    subject: input.subject,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.refs !== undefined ? { refs: input.refs } : {}),
  };
  const effect = await dispatcher.appendLogEntry(entry);
  return {
    result: ok(entry),
    effects: [effect],
  };
}

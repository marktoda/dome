// Shared captured-task splice — the single task-creation grammar for agents.
// ingest uses its per-source capturedAwareAppendTool; the brief uses
// spliceCapturedTask per finding (each finding carries its own source URL).
import {
  appendCapturedTaskLines,
  appendOriginMarker,
  isCapturedTaskLine,
  CAPTURED_LINE_MAX_CHARS,
} from "../../dome.daily/processors/captured-block";

export type SpliceCapturedTaskResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

/** Validate one model-authored task line, stamp the ([↗](sourceUrl)) origin
 *  marker (Plan 1 grammar) when sourceUrl is given, and splice it into the
 *  captured block of `content`. The CAPTURED_LINE_MAX_CHARS cap measures the
 *  model-authored text; the marker is seam overhead (added after validation). */
export function spliceCapturedTask(input: {
  readonly content: string;
  readonly task: string;
  readonly sourceUrl?: string;
}): SpliceCapturedTaskResult {
  const line = input.task.trimEnd();
  if (line.length > CAPTURED_LINE_MAX_CHARS) {
    return { ok: false, error: `task line exceeds ${CAPTURED_LINE_MAX_CHARS} chars` };
  }
  if (!isCapturedTaskLine(line)) {
    return { ok: false, error: "not an open `- [ ] #task …` (or `#followup`) line" };
  }
  const stamped = input.sourceUrl !== undefined && input.sourceUrl !== ""
    ? appendOriginMarker(line, input.sourceUrl)
    : line;
  if (!isCapturedTaskLine(stamped)) {
    return { ok: false, error: "stamped task line failed validation (check the source URL)" };
  }
  return { ok: true, content: appendCapturedTaskLines({ content: input.content, lines: [stamped] }) };
}

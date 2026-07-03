// dome.daily/task-disposition — the pure task-line disposition transforms.
//
// The mechanical half of "settle a task": locate a task line by its
// move-stable `^block-anchor`, and rewrite its checkbox mark or `📅` due
// token. These are PURE string transforms (no fs, no clock, no engine) so
// BOTH consumers share one implementation:
//
//   - `dome.daily.settle-stale-answer` (a `patch.auto` garden processor) —
//     applies the owner's disposition to a stale-task question, emitting a
//     PatchEffect. Its "close" cancels (`[-]`); its "defer" pushes the date
//     forward by DEFER_DAYS from `ctx.now()`.
//   - `performSettle` (`src/surface/settle.ts`) — the commit-or-nothing settle
//     seam. Its "close" completes (`[x]`) and records a Done-today bullet; its
//     "defer" sets an explicit `deferUntil` date.
//
// The disposition SEMANTICS differ per consumer (which mark, which date); the
// LINE MECHANICS — find-by-anchor, flip-if-open, rewrite-or-insert-📅 while
// preserving the origin marker and trailing anchor — are identical and live
// here. The processor keeps owning its clock (`addDays`) and its effect
// emission; the surface keeps owning its fs/git. This module owns neither.
//
// Grammar dependencies are the shared task-line primitives: `parseBlockAnchor`
// (the core `^id` grammar) and the origin-marker grammar (`([↗](target))`,
// defined once in `action-extraction`). Keeping this module pure keeps it
// trivially testable and rebuild-safe, exactly like `src/core/block-anchor.ts`.

import { parseBlockAnchor } from "../../../../src/core/block-anchor";
import {
  appendOriginMarker,
  parseOriginMarker,
  semanticActionBody,
  stripOriginMarker,
} from "./action-extraction";

/**
 * Find the line (0-indexed in `lines`) whose trailing `^id` block anchor
 * equals `anchor`. Returns the index, or -1 when no line carries it. A
 * mid-line caret does not count — identity is the trailing anchor only.
 */
export function findAnchorLine(
  lines: ReadonlyArray<string>,
  anchor: string,
): number {
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = parseBlockAnchor(lines[i] ?? "");
    if (parsed !== null && parsed.id === anchor) return i;
  }
  return -1;
}

/** True iff `line` is an OPEN checkbox (`- [ ] …`). */
export function isOpenCheckbox(line: string): boolean {
  return /^\s*[-*]\s+\[ \]/.test(line);
}

/**
 * Set the checkbox mark of an OPEN checkbox line to `mark`
 * (`x` = done, `-` = cancelled, ` ` = re-open). Rewrites only when the line
 * is currently open — a non-open or non-checkbox line returns null, which is
 * how both callers stay idempotent (settling an already-settled line is a
 * no-op). The leading list marker, body, origin marker, and trailing anchor
 * are all preserved verbatim.
 */
export function setCheckboxMark(
  line: string,
  mark: "x" | "-" | " ",
): string | null {
  if (!isOpenCheckbox(line)) return null;
  return line.replace(/^(\s*[-*]\s+)\[ \]/, `$1[${mark}]`);
}

/**
 * Rewrite (or insert) the `📅 YYYY-MM-DD` due token on a task line to
 * `isoDate`, preserving the origin marker and the trailing `^anchor`.
 *
 *   1. Split off the trailing `^anchor` with `parseBlockAnchor`.
 *   2. Strip any origin marker from the body region (remembering its target).
 *   3. Replace an existing `📅 date`, or append one when absent.
 *   4. Re-append the origin marker in canonical position (after date, before
 *      anchor) — so a marker-before-date input is normalized on rewrite.
 *   5. Re-attach the anchor suffix.
 *
 * Canonical order: `body text 📅 date ([↗](url)) ^anchor`.
 */
export function setDueDate(line: string, isoDate: string): string {
  const parsed = parseBlockAnchor(line);
  const bodyPart = parsed !== null ? parsed.withoutAnchor : line.trimEnd();
  const anchorSuffix = parsed !== null ? ` ^${parsed.id}` : "";

  const originParsed = parseOriginMarker(bodyPart);
  const bareBody =
    originParsed !== null ? originParsed.body.trimEnd() : bodyPart;
  const originTarget = originParsed?.target ?? "";

  const dateRe = /(?:^|(\s))📅\s*\d{4}-\d{2}-\d{2}/u;
  let newBareBody: string;
  if (dateRe.test(bareBody)) {
    newBareBody = bareBody.replace(
      /(\s?)📅\s*\d{4}-\d{2}-\d{2}/u,
      (_, leadingSpace: string | undefined) =>
        `${leadingSpace ?? ""} 📅 ${isoDate}`.replace(/\s{2,}/g, " "),
    );
  } else {
    newBareBody = `${bareBody.trimEnd()} 📅 ${isoDate}`;
  }

  // appendOriginMarker is idempotent and a no-op when originTarget is empty.
  const newBody = appendOriginMarker(newBareBody, originTarget);
  return `${newBody}${anchorSuffix}`;
}

/**
 * The clean, human-readable body of a task line — checkbox marker, trailing
 * `^anchor`, and origin marker removed, `#task`/`#follow-up` tag prefixes
 * dropped (`semanticActionBody`). Used for the settle commit subject and the
 * Done-today bullet text. Falls back to the trimmed line when the line is not
 * a recognizable checkbox (e.g. a `todo:` directive).
 */
export function taskLineBody(line: string): string {
  const withoutAnchor = parseBlockAnchor(line)?.withoutAnchor ?? line;
  const withoutOrigin = stripOriginMarker(withoutAnchor);
  const match = /^\s*[-*]\s+\[[ xX-]\]\s+(.*)$/.exec(withoutOrigin);
  const raw = (match !== null ? match[1] ?? "" : withoutOrigin).trim();
  return semanticActionBody(raw);
}

const DONE_TODAY_HEADING = "### Done today";
const HEADING_RE = /^#{1,6}\s/;

/**
 * Append `bullet` under today's daily `### Done today` heading — the settle
 * seam's record half. Insertion-anchored, never positional: an existing
 * `### Done today` section (the human's, or the evening `dome.daily:close`
 * block's) gets the bullet as its last item; otherwise the section is created
 * under `## Done` (before `## Story of the Day` when present, appended
 * otherwise). Pure — the caller owns the fs/commit. This is the "Done today"
 * sibling of `daily-scaffold`'s `insertCloseScaffoldSection`; it deliberately
 * writes a bare heading (no generated-block markers) because a live settle is
 * a human bullet under the shared `## Done` section, not a machine-owned
 * block ([[wiki/specs/daily-surface]] §"Block ownership" — `## Done` is shared
 * scaffold + human bullets/edits).
 */
export function appendDoneTodayBullet(content: string, bullet: string): string {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => /^###\s+Done today\s*$/.test(l));

  if (headingIdx !== -1) {
    // Insert at the end of the existing section (before the next heading),
    // trimming trailing blank lines so the bullet lands flush.
    let end = headingIdx + 1;
    while (end < lines.length && !HEADING_RE.test(lines[end] ?? "")) end += 1;
    let insertAt = end;
    while (insertAt > headingIdx + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
      insertAt -= 1;
    }
    lines.splice(insertAt, 0, bullet);
    return lines.join("\n");
  }

  // No section yet — create it under `## Done`.
  const section = [DONE_TODAY_HEADING, bullet];
  const doneIdx = lines.findIndex((l) => /^##\s+Done\s*$/.test(l));
  if (doneIdx !== -1) {
    lines.splice(doneIdx + 1, 0, "", ...section);
    return lines.join("\n");
  }

  // No `## Done` heading — insert one before `## Story of the Day`, else append.
  const storyIdx = lines.findIndex((l) => /^##\s+Story of the Day\s*$/.test(l));
  const block = ["## Done", "", ...section, ""];
  if (storyIdx !== -1) {
    lines.splice(storyIdx, 0, ...block);
    return lines.join("\n");
  }
  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}\n${block.join("\n")}\n`;
}

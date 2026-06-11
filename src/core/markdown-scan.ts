// core/markdown-scan: shared markdown region scanners for processor authors.
//
// Covers frontmatter (YAML `---` delimited) and fenced code blocks (``` / ~~~).
// Two fence dialects exist in the wild — the dome.daily and dome.claims scanners
// diverged historically — and BOTH are preserved behind explicit options.
// Committed-vault identity (anchors, extraction) depends on each caller keeping
// its exact semantics. These behaviors are pinned by
// tests/core/markdown-scan-characterization.test.ts; do not "fix" a dialect.
//
// Dialect summary
// ───────────────
// dome.daily  — fences matched via `trimStart()` then /^(`{3,}|~{3,})/  (any
//               leading whitespace tolerated, incl. 4+ spaces); a same-char 3+
//               run always closes the open fence regardless of opener length.
// dome.claims — fences matched via /^[ ]{0,3}(`{3,}|~{3,})/ on the raw line
//               (0–3 leading spaces only, per CommonMark); closer must have
//               run-length >= opener's run-length.
//
// Pure (string-only, no IO).

/** 1-indexed, inclusive line range within a document. */
export type LineRange = { readonly start: number; readonly end: number };

export type FenceScanOptions = {
  /**
   * How leading whitespace is handled before the fence marker:
   *   "any"            — trim ALL leading whitespace before matching (dome.daily
   *                      default; recognizes 4+-space-indented fences).
   *   "up-to-3-spaces" — match the raw line against /^[ ]{0,3}.../ per CommonMark
   *                      (dome.claims); 4+ leading spaces are NOT a fence.
   */
  readonly indent?: "any" | "up-to-3-spaces";
  /**
   * Whether a closer must have a run-length >= the opener's run-length:
   *   false — any same-char 3+ run closes the fence (dome.daily default).
   *   true  — closer run must be at least as long as the opener (dome.claims).
   */
  readonly closeRequiresOpenerLength?: boolean;
};

/**
 * Return the 1-indexed, inclusive line range of the YAML frontmatter block, or
 * `null` if the document does not open with `---`.
 *
 * The close sentinel is the first subsequent line whose `.trim()` equals `---`.
 * An unterminated frontmatter block (no close sentinel) returns `null` — the
 * caller is responsible for deciding how to treat that case.  (dome.claims'
 * `excludedLineFlags` keeps its own frontmatter loop so it can treat an
 * unterminated block as "exclude to EOF"; that adapter does not call this
 * function for the frontmatter portion.)
 */
export function frontmatterLineRange(content: string): LineRange | null {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      return Object.freeze({ start: 1, end: i + 1 });
    }
  }
  return null;
}

/**
 * Return all 1-indexed, inclusive line ranges covered by fenced code blocks
 * (``` or ~~~) in the document.  Fence open/close lines are included in the
 * range.  An unterminated fence extends to end of file (last line number;
 * note content ending in a trailing newline splits to a phantom final ""
 * line, which counts — preserved from the original dome.daily behavior).
 *
 * Options default to the dome.daily dialect:
 *   `indent`                  — "any"   (trimStart before matching)
 *   `closeRequiresOpenerLength` — false (any same-char 3+ run closes)
 *
 * Pass `{ indent: "up-to-3-spaces", closeRequiresOpenerLength: true }` for the
 * dome.claims dialect.
 */
export function fencedCodeBlockLineRanges(
  content: string,
  opts?: FenceScanOptions,
): ReadonlyArray<LineRange> {
  const indent = opts?.indent ?? "any";
  const closeRequiresOpenerLength = opts?.closeRequiresOpenerLength ?? false;

  const lines = content.split(/\r?\n/);
  const ranges: { start: number; end: number }[] = [];
  let openLine = -1;
  let fenceChar = "";
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const match =
      indent === "any"
        ? /^(`{3,}|~{3,})/.exec(raw.trimStart())
        : /^[ ]{0,3}(`{3,}|~{3,})/.exec(raw);

    if (match === null) continue;
    const run = match[1] ?? "";
    const char = run.charAt(0);

    if (openLine < 0) {
      // Opening a new fence.
      openLine = i + 1;
      fenceChar = char;
      fenceLen = run.length;
    } else if (char === fenceChar) {
      // Potential closer — same character.
      const lengthOk = closeRequiresOpenerLength
        ? run.length >= fenceLen
        : true; // daily: any 3+ run closes
      if (lengthOk) {
        ranges.push({ start: openLine, end: i + 1 });
        openLine = -1;
        fenceChar = "";
        fenceLen = 0;
      }
    }
  }

  if (openLine > 0) ranges.push({ start: openLine, end: lines.length });
  return Object.freeze(ranges.map((r) => Object.freeze(r)));
}

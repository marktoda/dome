// engine/core/diff3: pure, IO-free line-based 3-way merge.
//
// The garden engine applies a processor's whole-file `write` change against a
// live candidate tree. Applying that as a blind whole-blob overwrite reverts
// concurrent edits to disjoint regions of the same file, producing a
// non-converging loop. `merge3` instead replays the processor's intended
// (base -> ours) diff onto the candidate (`theirs`), so disjoint edits compose.
//
// This is a classic line-based diff3 over LCS hunks. It has NO imports beyond TS
// built-ins and performs no IO. On an irreconcilable overlap it resolves
// *silently to ours* (the landed change wins; we never revert) and flags
// `conflict: true` — no `<<<<<<<` markers are emitted; the caller surfaces a
// diagnostic separately.

export type Merge3Result = { readonly text: string; readonly conflict: boolean };

export function merge3(input: {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}): Merge3Result {
  // Fast paths: if one side never moved from base, the other side's text is the
  // whole answer (and there can be no conflict).
  if (input.theirs === input.base) return { text: input.ours, conflict: false };
  if (input.ours === input.base) return { text: input.theirs, conflict: false };
  if (input.ours === input.theirs) return { text: input.ours, conflict: false };

  const baseLines = splitLines(input.base);
  const ourLines = splitLines(input.ours);
  const theirLines = splitLines(input.theirs);

  // Map each base line index to its matching line in ours / theirs (or -1).
  // These alignments are the spine the lockstep walk follows.
  const ourMatch = lcsMatch(baseLines, ourLines);
  const theirMatch = lcsMatch(baseLines, theirLines);

  const merged: string[] = [];
  let conflict = false;

  // Cursors into each sequence. b/o/t advance together across stable regions;
  // changed regions are the spans between consecutive shared anchor lines.
  let b = 0;
  let o = 0;
  let t = 0;

  while (b < baseLines.length) {
    const ob = ourMatch[b]!;
    const tb = theirMatch[b]!;

    if (ob >= 0 && tb >= 0) {
      // base[b] is an anchor present (unchanged) in BOTH sides. Emit any
      // inserted lines that precede the anchor in each side, then the anchor.
      const ourIns = ourLines.slice(o, ob);
      const theirIns = theirLines.slice(t, tb);
      emitChange(merged, [], ourIns, theirIns, () => (conflict = true));
      merged.push(baseLines[b]!);
      o = ob + 1;
      t = tb + 1;
      b += 1;
      continue;
    }

    // base[b] was changed/removed by at least one side. Gather the maximal run
    // of base lines that lack a common anchor, i.e. up to the next base line
    // that both sides still share.
    let b2 = b;
    while (b2 < baseLines.length && !(ourMatch[b2]! >= 0 && theirMatch[b2]! >= 0)) {
      b2 += 1;
    }
    // Region spans base[b..b2). The corresponding ours/theirs spans run up to
    // the next shared anchor (or end of sequence if there is none).
    const ourEnd = b2 < baseLines.length ? ourMatch[b2]! : ourLines.length;
    const theirEnd = b2 < baseLines.length ? theirMatch[b2]! : theirLines.length;
    const baseRegion = baseLines.slice(b, b2);
    const ourRegion = ourLines.slice(o, ourEnd);
    const theirRegion = theirLines.slice(t, theirEnd);

    emitChange(merged, baseRegion, ourRegion, theirRegion, () => (conflict = true));

    b = b2;
    o = ourEnd;
    t = theirEnd;
  }

  // Trailing insertions past the last base line (both sides may append).
  emitChange(merged, [], ourLines.slice(o), theirLines.slice(t), () => (conflict = true));

  const text = joinLines(merged, input.ours);
  return { text, conflict };
}

// Resolve one changed region. `base` is the region's original lines; `ours` and
// `theirs` are each side's replacement for it. Appends the chosen lines to
// `out`; calls `markConflict` on an irreconcilable overlap.
function emitChange(
  out: string[],
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  markConflict: () => void,
): void {
  const ourChanged = !sameLines(ours, base);
  const theirChanged = !sameLines(theirs, base);

  if (!ourChanged && !theirChanged) {
    // Neither side touched it: keep base (== ours == theirs).
    out.push(...base);
  } else if (ourChanged && !theirChanged) {
    out.push(...ours); // only ours moved
  } else if (!ourChanged && theirChanged) {
    out.push(...theirs); // only theirs moved
  } else if (sameLines(ours, theirs)) {
    out.push(...ours); // both made the identical change
  } else {
    // True conflict: resolve to ours, never reverting the landed change.
    markConflict();
    out.push(...ours);
  }
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Compute an LCS alignment from `base` onto `other`. Returns an array indexed by
// base line; each entry is the index of the matched line in `other`, or -1 if
// that base line is not part of the common subsequence (i.e. it was changed or
// removed). The chosen matches are mutually order-preserving.
function lcsMatch(base: readonly string[], other: readonly string[]): number[] {
  const n = base.length;
  const m = other.length;
  // dp[i][j] = LCS length of base[i..] and other[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (base[i] === other[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }
  const match = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === other[j]) {
      match[i] = j;
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

// Split a string into lines on "\n". The trailing newline (if any) is dropped
// here so it doesn't produce a spurious empty final element; joinLines restores
// the shape from `ours`.
function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// Join merged lines back to a string, matching the trailing-newline shape of
// `ours`: if ours ended with "\n", re-append one. (Empty `ours` has no trailing
// newline, so the result has none either — the fast paths cover empty-ours
// cases in practice.)
function joinLines(lines: readonly string[], ours: string): string {
  if (lines.length === 0) return "";
  const body = lines.join("\n");
  return ours.endsWith("\n") ? body + "\n" : body;
}

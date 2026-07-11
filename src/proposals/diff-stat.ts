/** Lightweight line edit size shared by proposal presentation and evaluation. */
export function lineDiffStat(
  base: string | null,
  proposed: string | null,
): { readonly added: number; readonly removed: number } {
  const baseLines = base === null ? [] : base.split("\n");
  const propLines = proposed === null ? [] : proposed.split("\n");
  let start = 0;
  const maxCommon = Math.min(baseLines.length, propLines.length);
  while (start < maxCommon && baseLines[start] === propLines[start]) start += 1;
  let endBase = baseLines.length;
  let endProp = propLines.length;
  while (
    endBase > start && endProp > start &&
    baseLines[endBase - 1] === propLines[endProp - 1]
  ) {
    endBase -= 1;
    endProp -= 1;
  }
  return { removed: endBase - start, added: endProp - start };
}

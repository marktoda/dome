// dome.markdown shared offset → position conversion.
//
// Consolidates the byte-identical `positionAt` helper that was copy-pasted in
// dome.markdown.wikilinks and dome.markdown.broken-images. Both anchor
// diagnostics / SourceRefs to the 1-indexed line and 0-indexed column an
// offset sits at, walking the content char-by-char (newline = 0x0A resets the
// column and advances the line).

export function positionAt(
  content: string,
  offset: number,
): { line: number; col: number } {
  let line = 1;
  let col = 0;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      col = 0;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

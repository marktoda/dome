import type { Caps } from "./caps";
import { bold, glyph, paint, statusGlyph, type Tone } from "./theme";
import { visibleWidth } from "./width";

export type Status = { readonly tone: Tone; readonly label: string };

export function statusValue(status: Status, caps: Caps): string {
  const g = statusGlyph(status.tone, caps);
  return `${g} ${paint(status.label, status.tone, caps)}`;
}

export function headline(
  left: { readonly cmd: string; readonly context?: string },
  status: Status,
  caps: Caps,
): string {
  const sep = glyph("sep", caps);
  const leftPlain =
    left.context !== undefined ? `dome ${left.cmd} ${sep} ${left.context}` : `dome ${left.cmd}`;
  // Color: dim "dome", bold cmd. Keep plain text for width math.
  const leftStyled = caps.color
    ? leftPlain.replace(`dome ${left.cmd}`, `${paint("dome", "muted", caps)} ${bold(left.cmd, caps)}`)
    : leftPlain;
  const right = statusValue(status, caps);
  const rightPlain = `${statusGlyph(status.tone, caps)} ${status.label}`;
  const gap = caps.width - visibleWidth(leftPlain) - visibleWidth(rightPlain);
  const spacer = gap >= 1 ? " ".repeat(gap) : "  ";
  return `${leftStyled}${spacer}${right}`;
}

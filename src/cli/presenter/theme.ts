import { createColors } from "picocolors";

import type { Caps } from "./caps";

export type Tone = "ok" | "warn" | "err" | "info" | "muted" | "ident" | "plain";
export type GlyphName = "ok" | "err" | "warn" | "pending" | "pointer" | "sep" | "bullet";

const c = createColors(true);

const UNICODE: Record<GlyphName, string> = {
  ok: "✓",
  err: "✗",
  warn: "⚠",
  pending: "○",
  pointer: "→",
  sep: "·",
  bullet: "•",
};

const ASCII: Record<GlyphName, string> = {
  ok: "√",
  err: "x",
  warn: "!",
  pending: "o",
  pointer: ">",
  sep: "-",
  bullet: "*",
};

export function glyph(name: GlyphName, caps: Caps): string {
  return (caps.unicode ? UNICODE : ASCII)[name];
}

export function paint(text: string, tone: Tone, caps: Caps): string {
  if (!caps.color || tone === "plain") return text;
  switch (tone) {
    case "ok":
      return c.green(text);
    case "warn":
      return c.yellow(text);
    case "err":
      return c.red(text);
    case "info":
      return c.cyan(text);
    case "ident":
      return c.cyan(text);
    case "muted":
      return c.dim(text);
  }
}

const TONE_GLYPH: Record<Tone, GlyphName> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  info: "bullet",
  muted: "pending",
  ident: "bullet",
  plain: "bullet",
};

export function statusGlyph(tone: Tone, caps: Caps): string {
  return glyph(TONE_GLYPH[tone], caps);
}

export function bold(text: string, caps: Caps): string {
  return caps.color ? c.bold(text) : text;
}

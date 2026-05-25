import type { WikiLink } from "./types";

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export function parseWikilinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const raw = match[0]!;
    const target = match[1]!.trim();
    links.push({
      raw,
      target,
      isFullPath: isFullPathLink(target),
    });
  }
  return links;
}

export function isFullPathLink(target: string): boolean {
  return /^(wiki|raw|notes|inbox)\//.test(target);
}

export function suggestFullPath(short: string): string {
  const slug = short.toLowerCase().replace(/\s+/g, "-");
  return `wiki/entities/${slug}`;
}

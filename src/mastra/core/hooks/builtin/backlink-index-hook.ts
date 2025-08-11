import fs from 'node:fs/promises';
import path from 'node:path';
import { afterSaveHook, NoteSaveContext } from '../note-hooks.js';
import { config } from '../../config.js';
import logger from '../../../utils/logger.js';
import { RelPath } from '../../../utils/path-utils.js';

// Path to the central backlinks file (human-readable so users can inspect it)
const BACKLINKS_FILE = path.join(config.DOME_VAULT_PATH, '.backlinks.json');

type BacklinkMap = Record<string, string[]>; // target -> sources

/* -----------------------------------------------------------
 * Link extraction helpers
 * ---------------------------------------------------------*/
function normaliseNotePath(link: string): RelPath | null {
  // remove any URL fragment (#heading) and leading ./
  let p = link.split('#')[0].trim();
  if (p.startsWith('./')) p = p.slice(2);

  // ignore external links and mailto etc.
  if (/^[a-zA-Z]+:\/\//.test(p) || p.startsWith('mailto:')) return null;

  // Ensure .md extension (common in wiki links)
  if (!p.endsWith('.md')) p += '.md';

  // Treat the cleaned path as vault-relative
  return p as RelPath;
}

function extractLinks(markdown: string): RelPath[] {
  const links = new Set<RelPath>();

  // Markdown links: [text](path/to/note.md)
  const mdRegex = /\[[^\]]*?\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRegex.exec(markdown)) !== null) {
    const rel = normaliseNotePath(m[1]);
    if (rel) links.add(rel);
  }

  // Wiki-links: [[path/to/note]] (extension optional)
  const wikiRegex = /\[\[([^\]]+?)]]/g;
  while ((m = wikiRegex.exec(markdown)) !== null) {
    const rel = normaliseNotePath(m[1]);
    if (rel) links.add(rel);
  }

  return [...links];
}

/* -----------------------------------------------------------
 * Backlink updater implementation
 * ---------------------------------------------------------*/
async function updateBacklinksIndex(ctx: NoteSaveContext): Promise<void> {
  const targets = extractLinks(ctx.currentRaw);
  if (!targets.length) {
    // Still need to purge previous links if the note was edited.
    await purgeNoteFromBacklinks(ctx.relPath);
    return;
  }

  let map: BacklinkMap = {};
  try {
    const json = await fs.readFile(BACKLINKS_FILE, 'utf8');
    map = JSON.parse(json) as BacklinkMap;
  } catch {
    /* file may not exist yet – start fresh */
  }

  // Remove current note from all existing backlink arrays.
  for (const key of Object.keys(map)) {
    map[key] = map[key].filter(src => src !== ctx.relPath);
    if (map[key].length === 0) delete map[key];
  }

  // Add new backlinks
  for (const target of targets) {
    if (!map[target]) map[target] = [];
    if (!map[target].includes(ctx.relPath)) {
      map[target].push(ctx.relPath);
    }
  }

  try {
    await fs.writeFile(BACKLINKS_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
    logger.info(`🔗 Backlink index updated (${targets.length} links from ${ctx.relPath})`);
  } catch (err) {
    logger.warn(`⚠️  backlink-index hook failed to write file: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

async function purgeNoteFromBacklinks(relPath: string): Promise<void> {
  let map: BacklinkMap;
  try {
    map = JSON.parse(await fs.readFile(BACKLINKS_FILE, 'utf8')) as BacklinkMap;
  } catch {
    return; // nothing to purge
  }
  let changed = false;
  for (const key of Object.keys(map)) {
    const arr = map[key];
    const next = arr.filter(src => src !== relPath);
    if (next.length !== arr.length) {
      changed = true;
      if (next.length) map[key] = next; else delete map[key];
    }
  }
  if (changed) {
    try {
      await fs.writeFile(BACKLINKS_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
      logger.info(`🔗 Purged backlinks for ${relPath}`);
    } catch (err) {
      logger.warn(`⚠️  backlink-index hook purge failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

export const backlinkIndexHook = afterSaveHook(
  'Backlink Index',
  updateBacklinksIndex,
  'Maintain central backlinks map in .backlinks.json after each note save'
); 
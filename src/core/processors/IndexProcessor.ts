import { FileProcessor, FileEvent, FileEventType } from './FileProcessor.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import crypto from 'node:crypto';
import logger from '../utils/logger.js';
import { getWatcherConfig } from '../../watcher/config.js';
import { NoteSummarizer } from '../services/NoteSummarizer.js';

type DirectoryIndexFile = {
  name: string;
  path: string;
  title: string;
  summary: string;
  lastModified: string;
  hash: string;
};

type DirectoryIndex = {
  version: '1';
  folder: string;
  lastUpdated: string;
  files: DirectoryIndexFile[];
};

export class IndexProcessor extends FileProcessor {
  readonly name = 'IndexProcessor';

  private readonly summarizer: NoteSummarizer;
  private readonly cfg = getWatcherConfig();

  constructor(opts: { summarizer: NoteSummarizer }) {
    super();
    this.summarizer = opts.summarizer;
  }

  protected async processFile(event: FileEvent): Promise<void> {
    const rel = event.relativePath;

    if (!rel.endsWith('.md')) return;
    if (path.basename(rel).startsWith('.')) return;

    const dirAbs = path.dirname(event.path);
    await this.rebuildDirectoryIndex(dirAbs);
  }

  private async rebuildDirectoryIndex(dirAbs: string): Promise<void> {
    const vaultRoot = this.cfg.vaultPath;
    const dirRel = path.relative(vaultRoot, dirAbs) || '.';

    logger.info(`[IndexProcessor] Rebuilding index for directory: ${dirRel}`);

    const prevIndex = await this.loadIndex(dirAbs);
    const prevByPath = new Map<string, DirectoryIndexFile>(
      prevIndex?.files.map(f => [f.path, f]) ?? []
    );

    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    const mdFiles = entries
      .filter(e => e.isFile())
      .map(e => e.name)
      .filter(n => n.toLowerCase().endsWith('.md'))
      .filter(n => !n.startsWith('.'));

    logger.debug(`[IndexProcessor] Found ${mdFiles.length} markdown files in ${dirRel}`);

    const outFiles: DirectoryIndexFile[] = [];

    for (const name of mdFiles) {
      const fileAbs = path.join(dirAbs, name);
      const fileRel = path.relative(vaultRoot, fileAbs).replace(/\\/g, '/');

      try {
        const [buf, stat] = await Promise.all([fs.readFile(fileAbs), fs.stat(fileAbs)]);
        const hash = sha256(buf);

        const raw = buf.toString('utf-8');
        const { data: fm, content } = matter(raw);
        const title = resolveTitle(fm?.title, content, name);

        const prev = prevByPath.get(fileRel);
        let summary: string;

        if (prev && prev.hash === hash && prev.summary) {
          summary = prev.summary;
          logger.debug(`[IndexProcessor] Reusing cached summary for ${name}`);
        } else {
          logger.debug(`[IndexProcessor] Generating new summary for ${name}`);
          summary = await this.summarizer.summarize({
            path: fileRel,
            title,
            content: raw,
            frontmatter: fm ?? {},
          });
        }

        outFiles.push({
          name,
          path: fileRel,
          title,
          summary,
          lastModified: stat.mtime.toISOString(),
          hash,
        });
      } catch (err) {
        logger.warn(`[IndexProcessor] Skipping ${fileRel}: ${String(err)}`);
      }
    }

    const nextIndex: DirectoryIndex = {
      version: '1',
      folder: dirRel.replace(/\\/g, '/'),
      lastUpdated: new Date().toISOString(),
      files: outFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    };

    const jsonPath = path.join(dirAbs, '.index.json');
    await atomicWrite(jsonPath, JSON.stringify(nextIndex, null, 2));
    logger.info(`[IndexProcessor] Updated index with ${outFiles.length} files: ${path.relative(vaultRoot, jsonPath)}`);
  }

  private async loadIndex(dirAbs: string): Promise<DirectoryIndex | undefined> {
    try {
      const p = path.join(dirAbs, '.index.json');
      const raw = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw) as DirectoryIndex;
      if (parsed.version !== '1' || !Array.isArray(parsed.files)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

function resolveTitle(fmTitle: unknown, content: string, fallbackName: string): string {
  const fromFm = typeof fmTitle === 'string' ? fmTitle.trim() : '';
  if (fromFm) return fromFm;
  const h1 = content.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim();
  if (h1) return h1;
  return path.basename(fallbackName, '.md');
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, 'utf-8');
  await fs.rename(tmp, filePath);
}
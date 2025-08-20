/**
 * FolderContextService
 * - Loads ancestor `.dome` files (root → leaf)
 * - Loads the current folder's .index.json (if present)
 * - Produces a small, typed bundle + optional prompt string
 */

import fs from 'node:fs/promises';
import path, { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { config } from '../utils/config.js';
import { NoteId } from '../entities/Note.js';

const DOME_FILENAME = '.dome';
const INDEX_JSON = '.index.json';
const DEFAULT_MAX_DEPTH = 10;

export type DomeEntry = {
  absDir: string;     // absolute directory path
  relDir: string;     // vault-relative directory path ('' means root folder)
  content: string;    // raw .dome text (can be empty string)
};

export type ContextBundle = {
  note: {
    absPath: string;
    relPath: string;
    dirAbs: string;
    dirRel: string;
    name: string;     // basename (file.ext)
  };
  // Ancestor dome files ordered root → leaf (closest last)
  domeChain: DomeEntry[];
  // Current folder index (if present)
  folderIndex: DirectoryIndex | null;
  // Convenience view of siblings (optionally filtered and limited)
  siblings: DirectoryIndexFile[];
};

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

export class FolderContextService {
  constructor(private readonly vaultRoot: string = config.DOME_VAULT_PATH) {}

  /**
   * Get the merged context for a note:
   * - Ancestor `.dome` files (root → leaf)
   * - Current folder `.index.json` (if present)
   * - Optional sibling filtering & limits
   */
  async getContext(
    noteId: NoteId | string,
    opts?: {
      maxDepth?: number;
      includeSiblingsOnly?: boolean;
      limitFiles?: number;
    }
  ): Promise<ContextBundle> {
    const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;

    const noteAbs = this.toAbsPath(String(noteId));
    const noteRel = this.toRelPath(noteAbs);
    const dirAbs = dirname(noteAbs);
    const dirRel = this.toRelPath(dirAbs);
    const name = path.basename(noteAbs);

    // 1) Collect ancestor dome files (root → leaf)
    const ancestors = this.ancestorDirs(dirAbs, maxDepth);
    const domeChain: DomeEntry[] = [];
    for (const absDir of ancestors) {
      const domeText = await this.readDome(absDir);
      if (domeText !== null) {
        domeChain.push({
          absDir,
          relDir: this.toRelPath(absDir),
          content: domeText,
        });
      }
    }

    // 2) Load current folder index
    const folderIndex = await this.readIndex(dirAbs); // can be null

    // 3) Siblings view
    let siblings: DirectoryIndexFile[] = folderIndex?.files ?? [];
    if (opts?.includeSiblingsOnly && folderIndex) {
      // Siblings = files in this folder (which .index.json represents), excluding the current note
      const noteRelNormalized = normalizeSlashes(noteRel);
      siblings = folderIndex.files.filter(f => normalizeSlashes(f.path) !== noteRelNormalized);
    }

    // 4) Limit number of file summaries if requested
    if (opts?.limitFiles && siblings.length > opts.limitFiles) {
      siblings = siblings.slice(0, opts.limitFiles);
    }

    return {
      note: { absPath: noteAbs, relPath: noteRel, dirAbs, dirRel, name },
      domeChain,
      folderIndex,
      siblings,
    };
  }

  /**
   * Render a compact, LLM-friendly prompt from a ContextBundle.
   * Keeps formatting minimal and explicit.
   */
  formatPrompt(
    bundle: ContextBundle,
    opts?: {
      includePaths?: boolean;     // defaults true
      includeFolderIndex?: boolean; // defaults true
      includeDomeChain?: boolean; // defaults true
      heading?: string;           // optional custom heading
      maxChars?: number;          // optional hard cap (simple clip)
    }
  ): string {
    const includePaths = opts?.includePaths ?? true;
    const includeFolderIndex = opts?.includeFolderIndex ?? true;
    const includeDomeChain = opts?.includeDomeChain ?? true;

    const lines: string[] = [];

    if (opts?.heading !== '') {
      lines.push(opts?.heading ?? '# Vault Context', '');
    }

    // Note info (lightweight)
    lines.push('## Note', `Name: ${bundle.note.name}`);
    if (includePaths) {
      lines.push(`Folder: /${bundle.note.dirRel || ''}`, `Path: /${bundle.note.relPath}`, '');
    } else {
      lines.push('');
    }

    if (includeDomeChain && bundle.domeChain.length) {
      lines.push('## Folder Rules (ancestor .dome, root → leaf)');
      for (const d of bundle.domeChain) {
        const header = includePaths ? `### /${d.relDir || ''} (.dome)` : '### .dome';
        lines.push(header, d.content.trim() ? d.content.trim() : '*(empty)*', '');
      }
    }

    if (includeFolderIndex && bundle.siblings.length) {
      lines.push('## Folder File Summaries');
      for (const f of bundle.siblings) {
        const link = `./${encodeURI(path.basename(f.path))}`;
        const title = f.title || path.basename(f.path);
        const pathLine = includePaths ? ` — /${f.path}` : '';
        lines.push(
          `### ${title}`,
          `Link: ${link}${pathLine}`,
          `Summary: ${f.summary.trim()}`,
          ''
        );
      }
    }

    let out = lines.join('\n');
    if (opts?.maxChars && out.length > opts.maxChars) {
      out = out.slice(0, opts.maxChars) + '\n\n…(truncated)';
    }
    return out;
  }

  /**
   * Get a full index of all contexts and indexes in the vault
   * @returns Formatted document with all contexts, indexes, their paths, and depths
   */
  async getIndex(): Promise<string | null> {
    const contextFiles = await this.listContextFiles();
    const indexFiles = await this.listIndexFiles();
    
    if (contextFiles.length === 0 && indexFiles.length === 0) return null;

    const contextData: Array<{
      path: string;
      depth: number;
      content: string | null;
      index: DirectoryIndex | null;
    }> = [];

    // Create a set of all unique directories
    const allDirs = new Set<string>();
    contextFiles.forEach(f => allDirs.add(dirname(f)));
    indexFiles.forEach(f => allDirs.add(dirname(f)));

    // Process each directory
    for (const dirPath of allDirs) {
      const [content, index] = await Promise.all([
        this.readDome(dirPath),
        this.readIndex(dirPath)
      ]);
      
      if (content || index) {
        // Calculate depth relative to vault root
        const relativePath = dirPath.replace(config.DOME_VAULT_PATH, '').replace(/^\//, '') || '/';
        const depth = relativePath === '/' ? 0 : relativePath.split('/').length;

        contextData.push({
          path: dirPath,
          depth,
          content,
          index,
        });
      }
    }

    // Sort by path to ensure consistent ordering
    contextData.sort((a, b) => a.path.localeCompare(b.path));

    // Format the index document
    const indexParts = [
      '# Dome Context & Index Overview',
      `Generated at: ${new Date().toISOString()}`,
      `Total folders with context/index: ${contextData.length}`,
      '',
      '='.repeat(80),
      '',
    ];

    // Add each context with formatting
    for (const ctx of contextData) {
      const indent = '  '.repeat(ctx.depth);
      const relativePath = ctx.path.replace(config.DOME_VAULT_PATH, '') || '/';

      indexParts.push(
        `${indent}## Folder: ${relativePath}`,
        `${indent}Depth: ${ctx.depth}`,
        `${indent}Full path: ${ctx.path}`,
        ''
      );

      // Add .dome content if present
      if (ctx.content) {
        indexParts.push(
          `${indent}### Context (.dome):`,
          ctx.content
            .split('\n')
            .map(line => `${indent}${line}`)
            .join('\n'),
          ''
        );
      }

      // Add index summary if present
      if (ctx.index?.files && ctx.index.files.length > 0) {
        indexParts.push(
          `${indent}### Index (.index.json):`,
          `${indent}Files: ${ctx.index.files.length}`,
          ''
        );
        
        for (const file of ctx.index.files) {
          indexParts.push(`${indent}- **${file.title}** (${file.name})`);
          if (file.summary) {
            indexParts.push(`${indent}  ${file.summary}`);
          }
        }
        indexParts.push('');
      }

      indexParts.push('-'.repeat(80), '');
    }

    return indexParts.join('\n');
  }

  /**
   * Get both .dome context and .index.json for a specific folder
   * @param folderPath - Absolute path to the folder
   * @returns Object with dome content and index
   */
  async getFolderContext(folderPath: string): Promise<{ dome: string | null; index: DirectoryIndex | null }> {
    const [dome, index] = await Promise.all([
      this.readDome(folderPath),
      this.readIndex(folderPath)
    ]);
    return { dome, index };
  }

  /** Create or overwrite a `.dome` file in a folder */
  async createContext(folderPath: string, content: string): Promise<void> {
    const p = join(folderPath, DOME_FILENAME);
    await fs.writeFile(p, content, 'utf-8');
  }

  /**
   * List all contexts in the vault
   * @returns Array of context paths and configurations
   */
  async listContexts(): Promise<
    Array<{
      path: string;
      context: string | null;
    }>
  > {
    const contextFiles = await this.listContextFiles();

    const contexts = await Promise.all(
      contextFiles.map(async filePath => ({
        path: dirname(filePath).replace(config.DOME_VAULT_PATH, '').replace(/^\//, '') || '/',
        context: await this.readDome(dirname(filePath)),
      }))
    );

    return contexts.filter(c => c.context !== null);
  }

  /* ---------------- private helpers ---------------- */

  /** Return absolute path inside the vault for a note or absolute path as-is */
  private toAbsPath(notePath: string): string {
    return isAbsolute(notePath) ? notePath : join(this.vaultRoot, notePath);
  }

  /** Return vault-relative path ('' for root dir) with forward slashes */
  private toRelPath(absPath: string): string {
    const rel = relative(this.vaultRoot, absPath);
    return normalizeSlashes(rel || '');
  }

  /** Build list of ancestor dirs from vault root → given dir (bounded by maxDepth) */
  private ancestorDirs(leafDirAbs: string, maxDepth: number): string[] {
    const dirs: string[] = [];
    let current = resolve(leafDirAbs);
    let depth = 0;

    // Gather leaf → root, then reverse
    while (true) {
      dirs.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      depth++;
      if (depth >= maxDepth) break;
    }

    // Cut off ancestors outside the vault
    const withinVault = dirs.filter(d => normalizeSlashes(d).startsWith(normalizeSlashes(this.vaultRoot)));
    return withinVault.reverse(); // root → leaf
  }

  private async readDome(dirAbs: string): Promise<string | null> {
    try {
      const p = join(dirAbs, DOME_FILENAME);
      return await fs.readFile(p, 'utf-8');
    } catch {
      return null;
    }
  }

  private async readIndex(dirAbs: string): Promise<DirectoryIndex | null> {
    try {
      const p = join(dirAbs, INDEX_JSON);
      const raw = await fs.readFile(p, 'utf-8');
      const parsed = JSON.parse(raw) as DirectoryIndex;
      if (parsed?.version !== '1' || !Array.isArray(parsed.files)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Helper method to list all context files in the vault
   */
  private async listContextFiles(): Promise<string[]> {
    const files: string[] = [];

    const walkDir = async (dir: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.name === DOME_FILENAME) {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore directories we can't read
      }
    };

    await walkDir(config.DOME_VAULT_PATH);
    return files;
  }

  /**
   * Helper method to list all index files in the vault
   */
  private async listIndexFiles(): Promise<string[]> {
    const files: string[] = [];

    const walkDir = async (dir: string) => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else if (entry.name === INDEX_JSON) {
            files.push(fullPath);
          }
        }
      } catch {
        // Ignore directories we can't read
      }
    };

    await walkDir(config.DOME_VAULT_PATH);
    return files;
  }
}

/* ---------- local utils ---------- */

function normalizeSlashes(p: string): string {
  return p.split(sep).join('/');
}
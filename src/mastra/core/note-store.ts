import { RelPath, toAbs } from '../utils/path-utils.js';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import { config } from './config.js';
import { noteEvents } from './events.js';

export interface RawNote {
  path: NoteId;
  raw: string;
  fullPath: string;
}

export interface WriteResult {
  path: NoteId; // relative
  title: string;
  action: 'created' | 'updated';
  contentLength: number;
  fullPath: string; // absolute
}

export interface RemoveResult {
  path: NoteId;
  success: boolean;
  message: string;
}

/**
 * Alias for readability – a note identifier is simply the vault-relative path.
 */
export type NoteId = RelPath;

export interface FileWriteResult {
  path: NoteId;
  fullPath: string;
  existedBefore: boolean;
  bytesWritten: number;
}

export interface NoteStore {
  /** Retrieve and parse a note, or null if it doesn't exist */
  get(id: NoteId): Promise<RawNote | null>;

  /** Overwrite the note with raw markdown */
  store(id: NoteId, raw: string): Promise<FileWriteResult>;

  /** Quick existence check without reading the file */
  exists(id: NoteId): Promise<boolean>;

  /** List all notes */
  /** List all note files in the vault (no parsing) */
  list(): Promise<{ path: NoteId; fullPath: string }[]>;

  /** Delete a note */
  remove(id: NoteId): Promise<RemoveResult>;
}

class FileSystemNoteStore implements NoteStore {
  /* ------------------------------------------------------------------ Helpers */
  private async prepareNoteFolder(relPath: RelPath): Promise<string> {
    const abs = toAbs(relPath);
    const filePath = path.extname(abs) ? abs : `${abs}.md`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  /* ------------------------------------------------------------------ API */

  async get(id: NoteId): Promise<RawNote | null> {
    const fullPath = toAbs(id);
    try {
      await fs.access(fullPath);
      const raw = await fs.readFile(fullPath, 'utf8');
      return { path: id, raw, fullPath };
    } catch {
      return null;
    }
  }

  async store(id: NoteId, rawContent: string): Promise<FileWriteResult> {
    const relPath = id;
    const fullPath = await this.prepareNoteFolder(relPath);

    const existedBefore = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);

    await fs.writeFile(fullPath, rawContent, 'utf8');
    noteEvents.emit('note:changed', relPath);

    return {
      path: relPath,
      fullPath,
      existedBefore,
      bytesWritten: rawContent.length,
    };
  }

  async exists(id: NoteId): Promise<boolean> {
    try {
      await fs.access(toAbs(id));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<{ path: NoteId; fullPath: string }[]> {
    const paths = await fg('**/*.md', {
      cwd: config.DOME_VAULT_PATH,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });
    return paths.map(p => ({ path: p as NoteId, fullPath: path.join(config.DOME_VAULT_PATH, p) }));
  }

  async remove(id: NoteId): Promise<RemoveResult> {
    const fullPath = toAbs(id);
    try {
      await fs.access(fullPath);
      await fs.unlink(fullPath);
      noteEvents.emit('note:deleted', id);
      return { path: id, success: true, message: `Successfully removed note: ${id}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { path: id, success: false, message: `Failed to remove note ${id}: ${message}` };
    }
  }
}

/**
 * Default store backed by the local file system vault.
 */
export const noteStore: NoteStore = new FileSystemNoteStore();

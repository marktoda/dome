import { RelPath, toAbs } from '../utils/path-utils.js';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { NoteId, RawNote } from '../entities/Note.js';

export type StoreResult =
  | { type: StoreType.Created }
  | {
      type: StoreType.Updated;
      oldContent: string;
    };

export enum StoreType {
  Created = 'created',
  Updated = 'updated',
}

export type RemoveResult = {
  removedContent: string;
};

export interface NoteStore {
  /** Retrieve and parse a note, or null if it doesn't exist */
  get(id: NoteId): Promise<RawNote | null>;

  /** Overwrite the note with raw markdown */
  store(id: NoteId, raw: string): Promise<StoreResult>;

  /** Quick existence check without reading the file */
  exists(id: NoteId): Promise<boolean>;

  /** Delete a note */
  remove(id: NoteId): Promise<RemoveResult>;

  /** Rename a note to a new relative path */
  rename(from: NoteId, to: NoteId): Promise<void>;
}

export class FileSystemNoteStore implements NoteStore {
  async get(id: NoteId): Promise<RawNote | null> {
    const fullPath = toAbs(id);
    try {
      await fs.access(fullPath);
      const body = await fs.readFile(fullPath, 'utf8');
      return { id, body, fullPath };
    } catch {
      return null;
    }
  }

  async store(id: NoteId, rawContent: string): Promise<StoreResult> {
    const relPath = id;
    const fullPath = await this.prepareFolder(relPath);

    let result: StoreResult;
    if (await this.exists(id)) {
      const body = await fs.readFile(fullPath, 'utf8');
      result = {
        type: StoreType.Updated,
        oldContent: body,
      };
    } else {
      result = {
        type: StoreType.Created,
      };
    }

    await fs.writeFile(fullPath, rawContent, 'utf8');

    return result;
  }

  async exists(id: NoteId): Promise<boolean> {
    try {
      await fs.access(toAbs(id));
      return true;
    } catch {
      return false;
    }
  }

  async remove(id: NoteId): Promise<RemoveResult> {
    const fullPath = toAbs(id);
    const body = await fs.readFile(fullPath, 'utf8');
    await fs.access(fullPath);
    await fs.unlink(fullPath);
    return { removedContent: body };
  }

  async rename(from: NoteId, to: NoteId): Promise<void> {
    const fromAbs = toAbs(from);
    const toAbsPath = toAbs(to);

    // Ensure source exists
    await fs.access(fromAbs);

    // Ensure destination folder exists
    await fs.mkdir(path.dirname(toAbsPath), { recursive: true });

    // Perform rename (will fail if destination exists)
    await fs.rename(fromAbs, toAbsPath);
  }

  /* ------------------------------------------------------------------ Helpers */
  private async prepareFolder(relPath: RelPath): Promise<string> {
    const abs = toAbs(relPath);
    const filePath = path.extname(abs) ? abs : `${abs}.md`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return filePath;
  }
}

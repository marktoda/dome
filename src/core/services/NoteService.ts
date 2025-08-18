import { NoteId, RawNote, NoteMeta, Note } from '../entities/Note.js';
import { EventBus } from '../events/EventBus.js';
import { NoteEventType, NoteCreatedEvent, NoteUpdatedEvent, NoteRemovedEvent } from '../events/types.js';
import logger from '../utils/logger.js';
import fs from 'node:fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { toRel } from '../utils/path-utils.js';
import fg from 'fast-glob';
import { config } from '../utils/config.js';
import {
  FileSystemNoteStore,
  RemoveResult,
  StoreResult,
  NoteStore,
  StoreType,
} from '../store/NoteStore.js';
export { NoteId };

export class NoteService {
  constructor(
    private eventBus: EventBus,
    public store: NoteStore = new FileSystemNoteStore()
  ) {}

  async listNotes(): Promise<Note[]> {
    const paths = await fg('**/*.md', {
      cwd: config.DOME_VAULT_PATH,
      dot: false,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });
    const rawNotes: RawNote[] = await Promise.all(
      paths.map(p => this.store.get(toRel(p)) as Promise<RawNote>)
    );
    return await Promise.all(rawNotes.map(r => this.hydrateNote(r)));
  }

  async getNote(id: NoteId): Promise<Note | null> {
    const rawNote = await this.store.get(id);
    if (!rawNote) return null;
    return await this.hydrateNote(rawNote);
  }

  async writeNote(id: NoteId, content: string): Promise<StoreResult> {
    // TODO: consider writing some frontmatter coersion here

    const writeResult = await this.store.store(id, content);

    if (writeResult.type === StoreType.Created) {
      const event: NoteCreatedEvent = {
        type: NoteEventType.NoteCreated,
        noteId: id,
        content
      };
      await this.eventBus.emit(event);
    } else if (writeResult.type === StoreType.Updated) {
      const event: NoteUpdatedEvent = {
        type: NoteEventType.NoteUpdated,
        noteId: id,
        oldContent: writeResult.oldContent,
        newContent: content
      };
      await this.eventBus.emit(event);
    }
    return writeResult;
  }

  async removeNote(id: NoteId): Promise<RemoveResult> {
    const { removedContent } = await this.store.remove(id);
    const event: NoteRemovedEvent = {
      type: NoteEventType.NoteRemoved,
      noteId: id,
      content: removedContent
    };
    await this.eventBus.emit(event);
    return { removedContent };
  }

  // --------- HELPERS ------------

  private async hydrateNote(raw: RawNote): Promise<Note> {
    const meta = await this.deriveMeta(raw);
    return {
      ...raw,
      ...meta,
    };
  }

  private async deriveMeta(raw: RawNote): Promise<NoteMeta> {
    const stat = await fs.stat(raw.fullPath).catch(() => ({ birthtime: new Date() }));
    const fileName = path.basename(raw.fullPath, path.extname(raw.fullPath));
    // Compute the vault-relative path reliably so we don’t duplicate the vault prefix later
    const relativePath = toRel(raw.fullPath);

    // TODO: clean up how we handle frontmatter
    let title = fileName;
    let tags = [];
    try {
      const { data } = matter(raw.body);
      if (data.title) title = data.title;
      if (data.tags) tags = data.tags;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️  Failed to parse frontmatter for note ${raw.id}: ${msg}`);
    }

    return {
      id: relativePath,
      title: title,
      date: stat.birthtime.toISOString(),
      tags,
      path: relativePath,
    };
  }
}

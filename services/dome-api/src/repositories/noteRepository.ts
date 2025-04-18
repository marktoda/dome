import { BaseRepository } from './baseRepository';
import { Note, CreateNoteData, UpdateNoteData, NotePage, CreateNotePageData } from '../models/note';
import { notes, notePages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getDb, handleDatabaseError } from '../db';
import { Bindings } from '../types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Repository for Note operations
 */
export class NoteRepository extends BaseRepository<Note, CreateNoteData, UpdateNoteData> {
  /**
   * Constructor
   */
  constructor() {
    super(notes, notes.id);
  }

  /**
   * Create a new note
   * @param env Environment bindings
   * @param data Note data
   * @returns Created note
   */
  async create(env: Bindings, data: CreateNoteData): Promise<Note> {
    try {
      const now = Date.now();
      const noteData = {
        id: uuidv4(),
        userId: data.userId,
        title: data.title,
        body: data.body,
        contentType: data.contentType,
        r2Key: data.r2Key,
        metadata: data.metadata,
        createdAt: now,
        updatedAt: now,
        embeddingStatus: 'pending',
      };

      const db = getDb(env);
      const result = await db.insert(notes).values(noteData).returning().all();
      return result[0] as Note;
    } catch (error) {
      throw handleDatabaseError(error, 'create note');
    }
  }

  /**
   * Update a note
   * @param env Environment bindings
   * @param id Note ID
   * @param data Update data
   * @returns Updated note
   */
  async update(env: Bindings, id: string, data: UpdateNoteData): Promise<Note> {
    try {
      const updateData = {
        ...data,
        updatedAt: Date.now(),
      };

      const db = getDb(env);
      const result = await db
        .update(notes)
        .set(updateData)
        .where(eq(notes.id, id))
        .returning()
        .all();

      if (result.length === 0) {
        throw new Error(`Note with ID ${id} not found`);
      }

      return result[0] as Note;
    } catch (error) {
      throw handleDatabaseError(error, `update note(${id})`);
    }
  }

  /**
   * Find notes by user ID
   * @param env Environment bindings
   * @param userId User ID
   * @returns Array of notes
   */
  async findByUserId(env: Bindings, userId: string): Promise<Note[]> {
    return this.findBy(env, notes.userId, userId);
  }

  /**
   * Create a note page
   * @param env Environment bindings
   * @param data Note page data
   * @returns Created note page
   */
  async createPage(env: Bindings, data: CreateNotePageData): Promise<NotePage> {
    try {
      const pageData = {
        id: uuidv4(),
        noteId: data.noteId,
        pageNum: data.pageNum,
        content: data.content,
        createdAt: Date.now(),
      };

      const db = getDb(env);
      const result = await db.insert(notePages).values(pageData).returning().all();
      return result[0] as NotePage;
    } catch (error) {
      throw handleDatabaseError(error, 'create note page');
    }
  }

  /**
   * Find pages for a note
   * @param env Environment bindings
   * @param noteId Note ID
   * @returns Array of note pages
   */
  async findPagesByNoteId(env: Bindings, noteId: string): Promise<NotePage[]> {
    try {
      const db = getDb(env);
      const results = await db
        .select()
        .from(notePages)
        .where(eq(notePages.noteId, noteId))
        .orderBy(notePages.pageNum)
        .all();

      return results as NotePage[];
    } catch (error) {
      throw handleDatabaseError(error, `findPagesByNoteId(${noteId})`);
    }
  }

  /**
   * Delete a note and its pages
   * @param env Environment bindings
   * @param id Note ID
   * @returns True if deleted, false if not found
   */
  async delete(env: Bindings, id: string): Promise<boolean> {
    try {
      const db = getDb(env);
      // The foreign key constraint will automatically delete the pages
      const result = await db.delete(notes).where(eq(notes.id, id)).returning().all();

      return result.length > 0;
    } catch (error) {
      throw handleDatabaseError(error, `delete note(${id})`);
    }
  }
}

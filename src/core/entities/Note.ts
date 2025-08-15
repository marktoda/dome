import { RelPath } from '../utils/path-utils.js';

export type NoteId = RelPath;

export type NoteMeta = {
  id: NoteId;
  /** Note title (from frontmatter, first heading, or filename) */
  title: string;
  /** ISO date string when note was created */
  date: string;
  /** Array of tags from frontmatter */
  tags: string[];
  /** Relative path from vault root */
  path: NoteId;
};

export type RawNote = {
  id: NoteId;
  body: string;
  fullPath: string;
};

// TODO: any way to make sure the ids match or dedupe them
export type Note = NoteMeta & RawNote;

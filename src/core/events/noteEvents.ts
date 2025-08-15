import { EventEmitter } from 'events';
import { NoteId } from '../entities/Note';

/**
 * Global event bus for note-related events.
 *
 *   note:changed  – a note was created or modified (payload: relativePath)
 *   note:deleted  – a note was removed (payload: relativePath)
 */
export const noteEvents = new EventEmitter();

// Guarantee max listeners – avoid potential memory-leak warnings when many components subscribe.
noteEvents.setMaxListeners(50);

export enum NoteEventType {
  NoteCreated = 'note:created',
  NoteUpdated = 'note:updated',
  NoteRemoved = 'note:removed',
}

export type NoteEvent =
  | {
      type: NoteEventType.NoteCreated;
      noteId: NoteId;
    }
  | {
      type: NoteEventType.NoteUpdated;
      noteId: NoteId;
    }
  | {
      type: NoteEventType.NoteRemoved;
      noteId: string;
    };

// TODO: get generics working here
export interface NoteEventHandler {
  handle(event: NoteEvent): Promise<void>;
}

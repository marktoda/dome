import { EventEmitter } from 'events';

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

import { NoteId } from '../entities/Note.js';

export enum NoteEventType {
  NoteCreated = 'note:created',
  NoteUpdated = 'note:updated',
  NoteRemoved = 'note:removed',
}

export interface NoteCreatedEvent {
  type: NoteEventType.NoteCreated;
  noteId: NoteId;
  content: string;
}

export interface NoteUpdatedEvent {
  type: NoteEventType.NoteUpdated;
  noteId: NoteId;
  oldContent: string;
  newContent: string;
}

export interface NoteRemovedEvent {
  type: NoteEventType.NoteRemoved;
  noteId: NoteId;
  content: string;
}

export type NoteEvent = NoteCreatedEvent | NoteUpdatedEvent | NoteRemovedEvent;

export type EventMap = {
  [NoteEventType.NoteCreated]: NoteCreatedEvent;
  [NoteEventType.NoteUpdated]: NoteUpdatedEvent;
  [NoteEventType.NoteRemoved]: NoteRemovedEvent;
};

export type EventHandler<T extends NoteEvent> = (event: T) => Promise<void> | void;
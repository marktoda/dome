export enum FileEventType {
  Added = 'added',
  Changed = 'changed',
  Deleted = 'deleted',
}

export interface FileEvent {
  type: FileEventType;
  /** Absolute path on disk */
  path: string;
  /** Path relative to vault root */
  relativePath: string;
}

export interface FileState {
  hash: string;
  lastProcessed: string; // ISO for easy JSON
}
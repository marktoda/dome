export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: Date;
  isCollapsed?: boolean;
  streamingContent?: string;
  isStreaming?: boolean;
}

export interface ActivityEvent {
  id: string;
  type: 'tool' | 'document';
  name: string;
  timestamp: Date;
}

export interface IndexingStatus {
  progress: number;
  running: boolean;
  isIndexing: boolean;
  lastIndexTime: number;
}

export interface RootState {
  cfg: {
    timestamps: 'off' | 'relative' | 'absolute';
    verbose: boolean;
  };
  header: {
    vaultPath: string;
    noteCount: number;
  };
  chat: {
    messages: ChatMessage[];
    selectedIdx: number | null;
    streaming: boolean;
  };
  activity: ActivityEvent[];
  index: IndexingStatus;
  ui: {
    showHelp: boolean;
    showActivity: boolean;
  };
}

export type ChatAction =
  | {
      type: 'ADD_MESSAGE';
      payload: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: Date };
    }
  | { type: 'UPDATE_MESSAGE'; payload: { id: string; content: string; isStreaming?: boolean } }
  | { type: 'APPEND_TO_MESSAGE'; payload: { id: string; content: string } }
  | { type: 'FINISH_STREAMING'; payload: { id: string } }
  | { type: 'TOGGLE_COLLAPSE'; payload: { id: string } }
  | { type: 'SELECT_MESSAGE'; payload: number | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_STREAMING'; payload: boolean };

export type ActivityAction =
  | { type: 'ADD_ACTIVITY'; payload: Omit<ActivityEvent, 'id' | 'timestamp'> }
  | { type: 'CLEAR_OLD_ACTIVITIES' };

export type ConfigAction =
  | { type: 'SET_TIMESTAMP_MODE'; payload: 'off' | 'relative' | 'absolute' }
  | { type: 'SET_VERBOSE'; payload: boolean };

export type UIAction =
  | { type: 'TOGGLE_HELP' }
  | { type: 'TOGGLE_ACTIVITY' }
  | { type: 'SET_HELP_VISIBLE'; payload: boolean }
  | { type: 'SET_ACTIVITY_VISIBLE'; payload: boolean };

export type RootAction =
  | ChatAction
  | ActivityAction
  | ConfigAction
  | UIAction
  | { type: 'SET_VAULT_PATH'; payload: string }
  | { type: 'SET_NOTE_COUNT'; payload: number }
  | { type: 'UPDATE_INDEXING_STATUS'; payload: Partial<IndexingStatus> };

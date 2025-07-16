import { RootState, RootAction } from './types.js';
import { chatReducer, initialChatState } from './chatReducer.js';
import { activityReducer, initialActivityState } from './activityReducer.js';

export const initialRootState: RootState = {
  cfg: {
    timestamps: 'off',
    verbose: false,
  },
  header: {
    vaultPath: '',
    noteCount: 0,
  },
  chat: initialChatState,
  activity: initialActivityState,
  index: {
    progress: 0,
    running: false,
    isIndexing: false,
    lastIndexTime: 0,
  },
  ui: {
    showHelp: false,
    showActivity: true,
  },
};

export function rootReducer(state: RootState, action: RootAction): RootState {
  // Handle chat-specific actions
  if (
    'type' in action &&
    (action.type === 'ADD_MESSAGE' ||
      action.type === 'UPDATE_MESSAGE' ||
      action.type === 'APPEND_TO_MESSAGE' ||
      action.type === 'FINISH_STREAMING' ||
      action.type === 'TOGGLE_COLLAPSE' ||
      action.type === 'SELECT_MESSAGE' ||
      action.type === 'CLEAR_MESSAGES' ||
      action.type === 'SET_STREAMING')
  ) {
    return {
      ...state,
      chat: chatReducer(state.chat, action as any),
    };
  }

  // Handle activity-specific actions
  if (
    'type' in action &&
    (action.type === 'ADD_ACTIVITY' || action.type === 'CLEAR_OLD_ACTIVITIES')
  ) {
    return {
      ...state,
      activity: activityReducer(state.activity, action as any),
    };
  }

  switch (action.type) {
    case 'SET_TIMESTAMP_MODE':
      return {
        ...state,
        cfg: {
          ...state.cfg,
          timestamps: action.payload,
        },
      };

    case 'SET_VERBOSE':
      return {
        ...state,
        cfg: {
          ...state.cfg,
          verbose: action.payload,
        },
      };

    case 'SET_VAULT_PATH':
      return {
        ...state,
        header: {
          ...state.header,
          vaultPath: action.payload,
        },
      };

    case 'SET_NOTE_COUNT':
      return {
        ...state,
        header: {
          ...state.header,
          noteCount: action.payload,
        },
      };

    case 'UPDATE_INDEXING_STATUS':
      return {
        ...state,
        index: {
          ...state.index,
          ...action.payload,
        },
      };

    case 'TOGGLE_HELP':
      return {
        ...state,
        ui: {
          ...state.ui,
          showHelp: !state.ui.showHelp,
        },
      };

    case 'TOGGLE_ACTIVITY':
      return {
        ...state,
        ui: {
          ...state.ui,
          showActivity: !state.ui.showActivity,
        },
      };

    case 'SET_HELP_VISIBLE':
      return {
        ...state,
        ui: {
          ...state.ui,
          showHelp: action.payload,
        },
      };

    case 'SET_ACTIVITY_VISIBLE':
      return {
        ...state,
        ui: {
          ...state.ui,
          showActivity: action.payload,
        },
      };

    default:
      return state;
  }
}

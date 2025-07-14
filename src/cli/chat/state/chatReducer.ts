import { ChatMessage, ChatAction } from './types.js';

export interface ChatState {
  messages: ChatMessage[];
  selectedIdx: number | null;
  streaming: boolean;
}

const MAX_MESSAGES = 50;

export const initialChatState: ChatState = {
  messages: [],
  selectedIdx: null,
  streaming: false,
};

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'ADD_MESSAGE': {
      const newMessage: ChatMessage = {
        ...action.payload,
        id: action.payload.id || `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        timestamp: action.payload.timestamp || new Date(),
      };
      
      let messages = [...state.messages, newMessage];
      
      // Keep only the last MAX_MESSAGES to prevent memory issues
      if (messages.length > MAX_MESSAGES) {
        messages = messages.slice(-MAX_MESSAGES);
      }
      
      return {
        ...state,
        messages,
      };
    }
    
    case 'UPDATE_MESSAGE': {
      return {
        ...state,
        messages: state.messages.map(msg =>
          msg.id === action.payload.id
            ? { 
                ...msg, 
                content: action.payload.content,
                isStreaming: action.payload.isStreaming ?? msg.isStreaming
              }
            : msg
        ),
      };
    }
    
    case 'APPEND_TO_MESSAGE': {
      return {
        ...state,
        messages: state.messages.map(msg =>
          msg.id === action.payload.id
            ? { 
                ...msg, 
                content: msg.content + action.payload.content,
                streamingContent: (msg.streamingContent || '') + action.payload.content
              }
            : msg
        ),
      };
    }
    
    case 'FINISH_STREAMING': {
      return {
        ...state,
        messages: state.messages.map(msg =>
          msg.id === action.payload.id
            ? { ...msg, isStreaming: false, streamingContent: undefined }
            : msg
        ),
        streaming: false,
      };
    }
    
    case 'TOGGLE_COLLAPSE': {
      return {
        ...state,
        messages: state.messages.map(msg =>
          msg.id === action.payload.id
            ? { ...msg, isCollapsed: !msg.isCollapsed }
            : msg
        ),
      };
    }
    
    case 'SELECT_MESSAGE': {
      return {
        ...state,
        selectedIdx: action.payload,
      };
    }
    
    case 'CLEAR_MESSAGES': {
      return {
        ...state,
        messages: [],
        selectedIdx: null,
      };
    }
    
    case 'SET_STREAMING': {
      return {
        ...state,
        streaming: action.payload,
      };
    }
    
    default:
      return state;
  }
}
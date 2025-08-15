import { useInput } from 'ink';
import { ChatMessage } from '../state/types.js';
import { useCallback } from 'react';

// Generic Dispatch type for our reducer actions

export type Dispatch = (action: any) => void;

export interface ChatLikeState {
  messages: ChatMessage[];
  selectedIdx: number | null;
}

export const useGlobalShortcuts = (
  chat: ChatLikeState,
  dispatch: Dispatch,
  // exit from ink useApp
  exit: () => void
) => {
  const handler = useCallback(
    (input: string, key: Record<string, boolean>) => {
      if (key.ctrl && input === 'c') {
        exit();
      }
      if (key.ctrl && input === 'h') {
        dispatch({ type: 'TOGGLE_HELP' });
      }
      if (key.ctrl && input === 'a') {
        dispatch({ type: 'TOGGLE_ACTIVITY' });
      }

      // Navigation for message selection
      if (key.upArrow) {
        const assistantMessages = chat.messages.filter(m => m.type === 'assistant');
        if (assistantMessages.length === 0) return;
        if (chat.selectedIdx === null) {
          const lastAssistant = chat.messages.findIndex(
            m => m === assistantMessages[assistantMessages.length - 1]
          );
          dispatch({ type: 'SELECT_MESSAGE', payload: lastAssistant });
        } else {
          for (let i = chat.selectedIdx - 1; i >= 0; i--) {
            if (chat.messages[i].type === 'assistant') {
              dispatch({ type: 'SELECT_MESSAGE', payload: i });
              break;
            }
          }
        }
      }

      if (key.downArrow) {
        if (chat.selectedIdx === null) return;
        for (let i = chat.selectedIdx + 1; i < chat.messages.length; i++) {
          if (chat.messages[i].type === 'assistant') {
            dispatch({ type: 'SELECT_MESSAGE', payload: i });
            break;
          }
        }
      }

      // Toggle collapse
      if (input === 's' && chat.selectedIdx !== null) {
        const message = chat.messages[chat.selectedIdx];
        if (message && message.type === 'assistant' && message.content.length > 200) {
          dispatch({ type: 'TOGGLE_COLLAPSE', payload: { id: message.id } });
        }
      }
    },
    [chat, dispatch, exit]
  );

  // Bind once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useInput(handler);
};

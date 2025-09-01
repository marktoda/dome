import { useInput } from 'ink';
import { useCallback, useEffect, useRef } from 'react';
import { KeybindingManager, KeybindingContext } from '../keybindings/index.js';
import { ChatMessage } from '../state/types.js';

interface UseKeybindingsOptions {
  // State
  messages: ChatMessage[];
  selectedMessageIndex: number;
  noteLog: string[];
  selectedNoteIdx: number;
  showNoteLog: boolean;
  showDebugLog?: boolean;
  isProcessing: boolean;
  editorState: {
    isOpen: boolean;
    isTransitioning: boolean;
  };

  // Actions
  setSelectedMessageIndex: (index: number) => void;
  setSelectedNoteIdx: (index: number) => void;
  setShowNoteLog: (show: boolean) => void;
  setShowDebugLog?: (show: boolean) => void;
  exit: () => void;
  openNoteInEditor: (path: string) => void;
  addMessage: (message: ChatMessage) => void;
  clearMessages?: () => void;
}

export function useKeybindings(options: UseKeybindingsOptions) {
  const {
    messages,
    selectedMessageIndex,
    noteLog,
    selectedNoteIdx,
    showNoteLog,
    showDebugLog = false,
    isProcessing,
    editorState,
    setSelectedMessageIndex,
    setSelectedNoteIdx,
    setShowNoteLog,
    setShowDebugLog,
    exit,
    openNoteInEditor,
    addMessage,
    clearMessages,
  } = options;

  const managerRef = useRef<KeybindingManager | undefined>(undefined);

  // Store the options in a ref to avoid stale closures
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Initialize keybinding manager
  useEffect(() => {
    const manager = new KeybindingManager();

    // Register command handlers
    manager.initialize({
      // Application commands
      'app.exit': () => optionsRef.current.exit(),

      // UI toggle commands
      'ui.toggleActivity': () => {
        const { showNoteLog, setShowNoteLog } = optionsRef.current;
        setShowNoteLog(!showNoteLog);
      },
      'ui.toggleDebug': () => {
        const { showDebugLog, setShowDebugLog } = optionsRef.current;
        if (setShowDebugLog) {
          setShowDebugLog(!showDebugLog);
        }
      },

      // Note log commands
      'noteLog.selectNext': () => {
        const { noteLog, selectedNoteIdx, showNoteLog, setSelectedNoteIdx } = optionsRef.current;
        if (noteLog.length > 0 && showNoteLog) {
          setSelectedNoteIdx(Math.min(selectedNoteIdx + 1, noteLog.length - 1));
        }
      },
      'noteLog.selectPrevious': () => {
        const { noteLog, selectedNoteIdx, showNoteLog, setSelectedNoteIdx } = optionsRef.current;
        if (noteLog.length > 0 && showNoteLog) {
          setSelectedNoteIdx(Math.max(selectedNoteIdx - 1, 0));
        }
      },
      'noteLog.openSelected': () => {
        const { noteLog, selectedNoteIdx, showNoteLog, openNoteInEditor } = optionsRef.current;
        if (noteLog.length > 0 && showNoteLog && noteLog[selectedNoteIdx]) {
          openNoteInEditor(noteLog[selectedNoteIdx]);
        }
      },

      // (Message navigation keybindings removed)

      // Chat commands
      'chat.clear': () => {
        const { addMessage } = optionsRef.current;
        // Clear messages would be handled by the parent component
        // For now just add a system message
        addMessage({
          id: `${Date.now()}-s`,
          type: 'system',
          content: 'Use /clear command to clear chat history.',
          timestamp: new Date(),
        });
      },
      'chat.showStatus': () => {
        const { addMessage } = optionsRef.current;
        // This would show indexing status - implementation depends on state structure
        addMessage({
          id: `${Date.now()}-s`,
          type: 'system',
          content: 'Status: Ready',
          timestamp: new Date(),
        });
      },
    });

    managerRef.current = manager;
  }, []); // Only initialize once

  // Handle keyboard input
  const handleInput = useCallback(
    (input: string, key: Record<string, boolean>) => {
      if (!managerRef.current) return;

      // Build context for keybinding evaluation
      const context: KeybindingContext = {
        editorOpen: editorState.isOpen,
        editorTransitioning: editorState.isTransitioning,
        processing: isProcessing,
        hasMessages: messages.length > 0,
        hasNoteLog: noteLog.length > 0,
        noteLogVisible: showNoteLog,
        helpVisible: false, // Would need to be tracked in state
        activityVisible: showNoteLog, // Using note log as activity for now
        selectedMessageIndex: selectedMessageIndex === -1 ? null : selectedMessageIndex,
        inputFocused: !editorState.isOpen && !editorState.isTransitioning,
      };

      // Let the keybinding manager handle it; if handled, stop further processing so TextInput doesn't receive it
      const handled = managerRef.current.handleInput(input, key, context);
      if (handled) {
        return false; // prevent propagation to other useInput handlers (e.g. TextInput)
      }
    },
    [
      editorState.isOpen,
      editorState.isTransitioning,
      isProcessing,
      messages.length,
      noteLog.length,
      showNoteLog,
      selectedMessageIndex,
    ]
  );

  // Register with Ink's useInput
  useInput(handleInput);

  return {
    getHelpText: () => managerRef.current?.generateHelpText() || '',
  };
}

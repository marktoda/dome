import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useApp, useInput, useStdout, useStdin } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { mastra } from '../../../mastra/index.js';
import { ChatHistory } from './ChatHistory.js';
import { NoteLogPanel } from './NoteLogPanel.js';
import { setActivityTracker } from '../utils/activityTracker.js';
import { editorManager } from '../../services/editor-manager.js';
import { setInkIO } from '../../ink/ink-io.js';
import { ChatMessage } from '../state/types.js';
import { STREAMING } from '../constants.js';

// Throttle interval for stream updates (30ms ≈ 33 fps)
const FLUSH_INTERVAL = STREAMING.FLUSH_INTERVAL_MS || 30;

export const ChatApp: React.FC = () => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedMessageIndex, setSelectedMessageIndex] = useState(-1);
  const [timestampMode] = useState<'off' | 'relative' | 'absolute'>('relative');

  // Note access log state
  const [noteLog, setNoteLog] = useState<string[]>([]);
  const [selectedNoteIdx, setSelectedNoteIdx] = useState(0);
  const [showNoteLog, setShowNoteLog] = useState(true);

  // Editor state tracking
  const [editorState, setEditorState] = useState(() => editorManager.getState());

  // Terminal dimensions for responsive layout
  const { stdout } = useStdout();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();

  // Expose Ink IO globally for editor-service
  useEffect(() => {
    setInkIO({ stdin, setRawMode, isRawModeSupported });
  }, [stdin, setRawMode, isRawModeSupported]);

  const sidebarWidth = Math.max(20, Math.floor((stdout?.columns || 80) * 0.2));

  // Register global tracker for document accesses
  useEffect(() => {
    setActivityTracker({
      addActivity: (type, name) => {
        if (type === 'document') {
          setNoteLog(prev => {
            // Avoid duplicates while preserving order
            if (prev.includes(name)) return prev;
            const updated = [...prev, name];
            setSelectedNoteIdx(updated.length - 1);
            return updated;
          });
        }
      },
    });
  }, []);

  // Subscribe to editor state changes
  useEffect(() => {
    const handleStateChange = (state: typeof editorState) => {
      setEditorState(state);
    };

    editorManager.on('state:changed', handleStateChange);
    return () => {
      editorManager.off('state:changed', handleStateChange);
    };
  }, []);

  // Global keyboard handlers
  useInput((input, key) => {
    // Don't process keys when editor is open or transitioning
    if (editorState.isOpen || editorState.isTransitioning) {
      return;
    }

    // Toggle note log visibility – Ctrl+A
    if (key.ctrl && input === 'a') {
      setShowNoteLog(v => !v);
      return;
    }

    // Quit
    if (key.ctrl && input === 'c') {
      // Force close editor if open
      if (editorState.isOpen) {
        editorManager.forceClose();
      }
      exit();
      return;
    }

    // Scroll note log – Ctrl+J / Ctrl+Down
    if (noteLog.length > 0 && showNoteLog) {
      if (
        key.ctrl &&
        ((input === 'j' && !key.shift && !key.meta) || key.downArrow)
      ) {
        setSelectedNoteIdx(idx => Math.min(idx + 1, noteLog.length - 1));
        return;
      }

      // Scroll up – Ctrl+K / Ctrl+Up
      if (key.ctrl && ((input === 'k' && !key.shift && !key.meta) || key.upArrow)) {
        setSelectedNoteIdx(idx => Math.max(idx - 1, 0));
        return;
      }

      // Open selected note with Tab (when not processing)
      if (key.tab && !isProcessing) {
        // Check if enough time has passed since last editor close
        if (!editorManager.canOpenEditor()) {
          return;
        }

        const path = noteLog[selectedNoteIdx];
        if (path) {
          openNoteInEditor(path);
        }
        return;
      }
    }
  });

  // Function to open note in editor
  const openNoteInEditor = useCallback(async (path: string) => {
    try {
      await editorManager.openEditor({
        path,
        isNew: false,
        onOpen: () => {
          // Editor opened successfully
          addMessage({
            id: `${Date.now()}-s`,
            type: 'system',
            content: `Opening ${path} in editor...`,
            timestamp: new Date(),
          });
        },
        onClose: (success) => {
          // Editor closed
          if (!success) {
            addMessage({
              id: `${Date.now()}-e`,
              type: 'error',
              content: 'Editor closed with an error',
              timestamp: new Date(),
            });
          }
          // Input will auto-focus when editor closes
        },
        onError: (error) => {
          addMessage({
            id: `${Date.now()}-e`,
            type: 'error',
            content: `Error opening editor: ${error.message}`,
            timestamp: new Date(),
          });
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      addMessage({
        id: `${Date.now()}-e`,
        type: 'error',
        content: `Failed to open editor: ${msg}`,
        timestamp: new Date(),
      });
    }
  }, []);

  // Fallback: ensure SIGINT always exits even if Ink input gets detached
  useEffect(() => {
    const onSigInt = () => {
      if (editorState.isOpen) {
        editorManager.forceClose();
      }
      exit();
    };
    process.once('SIGINT', onSigInt);
    return () => {
      process.off('SIGINT', onSigInt);
    };
  }, [exit, editorState.isOpen]);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      // Echo user message
      addMessage({
        id: `${Date.now()}-u`,
        type: 'user',
        content: trimmed,
        timestamp: new Date(),
      });
      setInput('');
      if (trimmed === '/exit') {
        exit();
        return;
      }

      // Ask assistant
      setIsProcessing(true);
      try {
        const agent = await mastra.getAgent('notesAgent');

        // Create empty assistant message to be filled progressively
        const assistantId = `${Date.now()}-a`;
        const assistantMessage: ChatMessage = {
          id: assistantId,
          type: 'assistant',
          content: '',
          timestamp: new Date(),
          isStreaming: true,
        };
        addMessage(assistantMessage);

        // Build conversation history, filtering out error messages
        const conversationHistory = messages
          .filter(m => m.type !== 'error')
          .map(m => ({ role: m.type as 'user' | 'assistant', content: m.content }));

        // Add the current message to the history
        conversationHistory.push({ role: 'user' as const, content: trimmed });

        const stream = await agent.stream(conversationHistory);

        // Buffer for throttled updates
        let buffer = '';
        let flushTimer: NodeJS.Timeout | null = null;

        const flushBuffer = () => {
          if (buffer) {
            const text = buffer;
            buffer = '';
            setMessages(prev =>
              prev.map(m =>
                m.id === assistantId ? { ...m, content: m.content + text } : m
              )
            );
          }
        };

        for await (const chunk of stream.textStream) {
          buffer += chunk;

          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              flushBuffer();
            }, FLUSH_INTERVAL);
          }
        }

        // Final flush and mark as complete
        if (flushTimer) {
          clearTimeout(flushTimer);
        }
        flushBuffer();

        // Mark streaming as complete
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantId ? { ...m, isStreaming: false } : m
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        addMessage({
          id: `${Date.now()}-e`,
          type: 'error',
          content: `Error: ${message}`,
          timestamp: new Date(),
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [addMessage, exit, messages]
  );

  // Show editor status when active
  const showEditorStatus = editorState.isOpen || editorState.isTransitioning;

  return (
    <Box flexDirection="column" height="100%">
      {showEditorStatus && (
        <Box paddingX={1} paddingY={1} borderStyle="single" borderColor="yellow">
          <Text color="yellow">
            {editorState.isTransitioning
              ? '⏳ Transitioning to editor...'
              : '📝 Editor is open - terminal input disabled'}
          </Text>
        </Box>
      )}

      <Box flexDirection="row" flexGrow={1}>
        {/* Main chat area */}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {/* Message history using optimized ChatHistory component */}
          <ChatHistory
            messages={messages}
            timestampMode={timestampMode}
            selectedMessageIndex={selectedMessageIndex}
          />

          {/* Processing indicator */}
          {isProcessing && messages.length > 0 && !messages[messages.length - 1]?.isStreaming && (
            <Box paddingX={1}>
              <Text color="cyan">
                <Spinner type="dots" /> thinking…
              </Text>
            </Box>
          )}

          {/* Input area */}
          <Box paddingX={1} marginBottom={1} flexShrink={0}>
            <Text color="green">{'› '}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              focus={!isProcessing && !editorState.isOpen && !editorState.isTransitioning}
            />
          </Box>
        </Box>

        {showNoteLog && (
          <Box
            width={sidebarWidth}
            flexShrink={0}
            flexDirection="column"
            borderStyle="single"
            paddingLeft={1}
            borderColor={editorState.isOpen ? 'gray' : 'white'}
          >
            <NoteLogPanel
              notes={noteLog}
              selectedIdx={selectedNoteIdx}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};

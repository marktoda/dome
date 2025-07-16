import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { mastra } from '../../../mastra/index.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { NoteLogPanel } from './NoteLogPanel.js';
import { setActivityTracker } from '../utils/activityTracker.js';
import { NoteManager } from '../../services/note-manager.js';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
}

export const ChatApp: React.FC = () => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Note access log state
  const [noteLog, setNoteLog] = useState<string[]>([]);
  const [selectedNoteIdx, setSelectedNoteIdx] = useState(0);

  // Terminal dimensions for responsive layout
  const { stdout } = useStdout();
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

  // Global keyboard handlers
  useInput((input, key) => {
    // Quit
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // Scroll note log – Ctrl+J / Ctrl+Down
    if (noteLog.length > 0) {
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

      // Open selected note with Enter (when not processing)
      if (key.return && !isProcessing) {
        const path = noteLog[selectedNoteIdx];
        if (path) {
          const manager = new NoteManager();
          // Topic is unknown in this context – pass empty string
          manager
            .editNote('', path)
            .catch(err => {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              addMessage({ id: `${Date.now()}-e`, role: 'error', content: `Error: ${msg}` });
            })
            .finally(() => {
              // no-op
            });
        }
        return;
      }
    }
  });

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      // Echo user message
      addMessage({ id: `${Date.now()}-u`, role: 'user', content: trimmed });
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
        addMessage({ id: assistantId, role: 'assistant', content: '' });

        const stream = await agent.stream([{ role: 'user', content: trimmed }]);

        for await (const chunk of stream.textStream) {
          const text = chunk;
          setMessages(prev =>
            prev.map(m => (m.id === assistantId ? { ...m, content: m.content + text } : m))
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        addMessage({ id: `${Date.now()}-e`, role: 'error', content: `Error: ${message}` });
      } finally {
        setIsProcessing(false);
      }
    },
    [addMessage, exit]
  );

  const renderMessage = (msg: Message) => {
    const prefix = msg.role === 'user' ? 'You: ' : msg.role === 'assistant' ? 'Dome: ' : 'Error: ';
    const color = msg.role === 'user' ? 'green' : msg.role === 'assistant' ? 'cyan' : 'red';
    return (
      <Box key={msg.id} flexDirection="row" marginBottom={1}>
        <Text color={color}>{prefix}</Text>
        {msg.role === 'assistant' ? (
          <MarkdownRenderer content={msg.content} />
        ) : (
          <Text>{msg.content}</Text>
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="row" height="100%">
      {/* Main chat area */}
      <Box flexDirection="column" flexGrow={1}>
        {/* Message history */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="visible">
          {messages.map(renderMessage)}
          {isProcessing && (
            <Text color="cyan">
              <Spinner type="dots" /> thinking…
            </Text>
          )}
        </Box>

        {/* Input area */}
        <Box paddingX={1} marginBottom={1}>
          <Text color="green">{'› '}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            focus={!isProcessing}
          />
        </Box>
      </Box>

      {/* Note access log sidebar */}
      <Box
        width={sidebarWidth}
        flexDirection="column"
        borderStyle="single"
        paddingLeft={1}
      >
        <NoteLogPanel notes={noteLog} selectedIdx={selectedNoteIdx} />
      </Box>
    </Box>
  );
};

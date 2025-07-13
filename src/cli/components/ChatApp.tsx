import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { StatusBar } from './StatusBar.js';
import { ChatHistory } from './ChatHistory.js';
import { InputArea } from './InputArea.js';
import { HelpPanel } from './HelpPanel.js';
import { mastra } from '../../mastra/index.js';
import { backgroundIndexer } from '../../mastra/core/search.js';
import { listNotes } from '../../mastra/core/notes.js';

export interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: Date;
}

export interface IndexingStatus {
  isRunning: boolean;
  isIndexing: boolean;
  lastIndexTime: number;
}

export const ChatApp: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [indexingStatus, setIndexingStatus] = useState<IndexingStatus>({
    isRunning: false,
    isIndexing: false,
    lastIndexTime: 0
  });
  const [showHelp, setShowHelp] = useState(false);
  const [notesCount, setNotesCount] = useState<number>(0);
  const [vaultPath, setVaultPath] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);

  const { exit } = useApp();

  // Initialize the app
  useEffect(() => {
    const initialize = async () => {
      const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
      setVaultPath(vaultPath);

      const welcomeMessage: Message = {
        id: 'welcome',
        type: 'system',
        content: '🏠 Welcome to Dome AI Assistant! Type your question or use commands like "help", "list", "status".',
        timestamp: new Date()
      };
      setMessages([welcomeMessage]);

      // Load notes count
      try {
        const notes = await listNotes();
        setNotesCount(notes.length);
      } catch {
        setNotesCount(0);
      }

      // Configure and start background indexing
      try {
        backgroundIndexer.setStatusDisplay(false);
        backgroundIndexer.setSilentMode(true);
        await backgroundIndexer.startBackgroundIndexing();
      } catch (error) {
        addMessage({
          type: 'error',
          content: `Failed to start background indexing: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    };

    initialize();

    return () => {
      backgroundIndexer.stopBackgroundIndexing().catch(() => {/* Silent cleanup */ });
    };
  }, []);

  // Update indexing status with optimized frequency
  useEffect(() => {
    const updateStatus = () => {
      const status = backgroundIndexer.getStatus();
      setIndexingStatus(prev => {
        // Only update if status actually changed to prevent unnecessary renders
        if (prev.isRunning !== status.isRunning ||
          prev.isIndexing !== status.isIndexing ||
          Math.abs(prev.lastIndexTime - status.lastIndexTime) > 1000) { // Only update time if >1s difference
          return status;
        }
        return prev;
      });
    };

    updateStatus();
    const interval = setInterval(updateStatus, 5000); // Further reduced frequency for less flicker

    return () => clearInterval(interval);
  }, []);

  // Global keyboard shortcuts
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
    }
    if (key.ctrl && input === 'h') {
      setShowHelp(!showHelp);
    }
  });

  const addMessage = useCallback((message: Omit<Message, 'id' | 'timestamp'>) => {
    const newMessage: Message = {
      ...message,
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, newMessage]);
  }, []);

  const handleUserInput = useCallback(async (input: string) => {
    const trimmedInput = input.trim();
    if (!trimmedInput) return;

    addMessage({ type: 'user', content: trimmedInput });

    if (await handleBuiltinCommand(trimmedInput)) {
      return;
    }

    setIsProcessing(true);
    try {
      // Get context-aware agent based on current working directory
      const agent = await mastra.getAgent("notesAgent");

      const response = await agent.generate([{ role: 'user', content: trimmedInput }]);

      addMessage({
        type: 'assistant',
        content: response.text || 'I apologize, but I couldn\'t process your request. Please try rephrasing your question.'
      });
    } catch (error) {
      addMessage({
        type: 'error',
        content: `Error processing query: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setIsProcessing(false);
    }
  }, [addMessage]);

  const handleBuiltinCommand = useCallback(async (input: string): Promise<boolean> => {
    const [command, ...args] = input.split(' ');

    switch (command.toLowerCase()) {
      case 'help':
        setShowHelp(!showHelp);
        return true;

      case 'exit':
      case 'quit':
      case 'q':
        await backgroundIndexer.stopBackgroundIndexing();
        addMessage({
          type: 'system',
          content: '👋 Goodbye! Your notes are safe in the vault.'
        });
        setTimeout(() => exit(), 1000);
        return true;

      case 'clear':
        setMessages([]);
        addMessage({
          type: 'system',
          content: '🏠 Welcome back to Dome AI Assistant!'
        });
        return true;

      case 'list':
        await handleListCommand();
        return true;

      case 'status':
      case 'index':
        handleStatusCommand();
        return true;

      case 'quiet':
        backgroundIndexer.setStatusDisplay(false);
        addMessage({
          type: 'system',
          content: '🔇 Background indexing status messages disabled'
        });
        return true;

      case 'verbose':
        backgroundIndexer.setStatusDisplay(true);
        addMessage({
          type: 'system',
          content: '🔊 Background indexing status messages enabled'
        });
        return true;

      default:
        return false;
    }
  }, [addMessage, showHelp, exit]);

  const handleListCommand = useCallback(async () => {
    try {
      const notes = await listNotes();

      if (notes.length === 0) {
        addMessage({
          type: 'system',
          content: '📭 No notes found'
        });
        return;
      }

      // Show recent notes (last 10)
      const recentNotes = notes
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 10);

      let content = `📚 ${notes.length} notes:\n\n`;

      for (const note of recentNotes) {
        const timeAgo = formatTimeAgo(new Date(note.date));
        content += `📝 ${note.title} (${timeAgo})\n`;
      }

      if (notes.length > 10) {
        content += `\n... and ${notes.length - 10} more notes`;
      }

      addMessage({
        type: 'system',
        content
      });
    } catch (error) {
      addMessage({
        type: 'error',
        content: `Failed to list notes: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
  }, [addMessage]);

  const handleStatusCommand = useCallback(() => {
    const status = backgroundIndexer.getStatus();
    let content = '🔍 Background Indexing Status:\n\n';
    content += `Running: ${status.isRunning ? '✅ Yes' : '❌ No'}\n`;
    content += `Currently indexing: ${status.isIndexing ? '🔄 Yes' : '✅ No'}\n`;

    if (status.lastIndexTime > 0) {
      const lastIndexDate = new Date(status.lastIndexTime);
      const timeAgo = formatTimeAgo(lastIndexDate);
      content += `Last indexed: ${timeAgo}`;
    } else {
      content += 'Last indexed: Never';
    }

    addMessage({
      type: 'system',
      content
    });
  }, [addMessage]);

  const formatTimeAgo = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

    if (diffDays > 0) {
      if (diffDays === 1) return 'yesterday';
      return `${diffDays}d ago`;
    } else if (diffHours > 0) {
      return `${diffHours}h ago`;
    } else {
      return 'today';
    }
  };

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar
        vaultPath={vaultPath}
        notesCount={notesCount}
        indexingStatus={indexingStatus}
      />

      <Box flexGrow={1} flexDirection="row" minHeight={0}>
        <Box flexGrow={1} flexDirection="column" minHeight={0}>
          <Box flexGrow={1} minHeight={0}>
            <ChatHistory messages={messages} isProcessing={isProcessing} />
          </Box>
          <InputArea onSubmit={handleUserInput} isDisabled={isProcessing} />
        </Box>

        {showHelp && (
          <Box width={35} borderStyle="single" borderColor="blue" paddingX={1}>
            <HelpPanel />
          </Box>
        )}
      </Box>
    </Box>
  );
};

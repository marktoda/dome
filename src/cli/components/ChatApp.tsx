import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { StatusBar } from './StatusBar.js';
import { ChatHistory } from './ChatHistory.js';
import { InputArea } from './InputArea.js';
import { HelpPanel } from './HelpPanel.js';
import { mastra } from '../../mastra/index.js';
import { backgroundIndexer } from '../../mastra/core/background-indexer.js';
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
      // Set vault path
      const path = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
      setVaultPath(path);

      // Add welcome message
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

      // Start background indexing
      try {
        backgroundIndexer.setStatusDisplay(false); // We'll handle status display ourselves
        await backgroundIndexer.startBackgroundIndexing();
      } catch (error) {
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          type: 'error',
          content: `Failed to start background indexing: ${error instanceof Error ? error.message : 'Unknown error'}`,
          timestamp: new Date()
        };
        setMessages(prev => [...prev, errorMessage]);
      }
    };

    initialize();

    // Cleanup on unmount
    return () => {
      backgroundIndexer.stopBackgroundIndexing().catch(console.error);
    };
  }, []);

  // Update indexing status periodically
  useEffect(() => {
    const updateStatus = () => {
      const status = backgroundIndexer.getStatus();
      setIndexingStatus(status);
    };

    updateStatus();
    const interval = setInterval(updateStatus, 1000);

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
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, newMessage]);
  }, []);

  const handleUserInput = useCallback(async (input: string) => {
    const trimmedInput = input.trim();
    if (!trimmedInput) return;

    // Add user message
    addMessage({
      type: 'user',
      content: trimmedInput
    });

    // Handle built-in commands
    if (await handleBuiltinCommand(trimmedInput)) {
      return;
    }

    // Process with AI agent
    setIsProcessing(true);
    try {
      const agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not found');
      }

      const response = await agent.generate([
        { role: 'user', content: trimmedInput }
      ]);

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
      
      <Box flexGrow={1} flexDirection="row">
        <Box flexGrow={1} flexDirection="column">
          <ChatHistory messages={messages} isProcessing={isProcessing} />
          <InputArea onSubmit={handleUserInput} isDisabled={isProcessing} />
        </Box>
        
        {showHelp && (
          <Box width={40} borderStyle="single" borderColor="blue">
            <HelpPanel />
          </Box>
        )}
      </Box>
      
      <Box borderStyle="single" borderColor="gray">
        <Text dimColor> Ctrl+C: Exit | Ctrl+H: Toggle Help | Commands: help, list, status, clear, exit </Text>
      </Box>
    </Box>
  );
};
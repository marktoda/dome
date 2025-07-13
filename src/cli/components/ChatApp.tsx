import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { StatusBar } from './StatusBar.js';
import { ChatHistory } from './ChatHistory.js';
import { InputArea } from './InputArea.js';
import { HelpPanel } from './HelpPanel.js';
import { BottomStatusBar } from './BottomStatusBar.js';
import { ActivityPanel, Activity } from './ActivityPanel.js';
import { mastra } from '../../mastra/index.js';
import { backgroundIndexer } from '../../mastra/core/search.js';
import { listNotes } from '../../mastra/core/notes.js';
import { setActivityTracker, analyzeAgentResponse } from '../utils/activityTracker.js';

export interface Message {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'error';
  content: string;
  timestamp: Date;
  isCollapsed?: boolean;
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
  const [showActivity, setShowActivity] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [notesCount, setNotesCount] = useState<number>(0);
  const [vaultPath, setVaultPath] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [timestampMode, setTimestampMode] = useState<'off' | 'relative' | 'absolute'>('off');
  const [selectedMessageIndex, setSelectedMessageIndex] = useState<number>(-1);

  const { exit } = useApp();
  const { stdout } = useStdout();

  const addActivity = useCallback((type: 'tool' | 'document', name: string) => {
    const newActivity: Activity = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      type,
      name,
      timestamp: new Date()
    };
    setActivities(prev => {
      // Keep only last 100 activities to prevent memory issues
      const updated = [...prev, newActivity];
      return updated.length > 100 ? updated.slice(-100) : updated;
    });
  }, []);

  // Initialize the app
  useEffect(() => {
    const initialize = async () => {
      const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
      setVaultPath(vaultPath);
      
      // Set up the global activity tracker
      setActivityTracker({ addActivity });

      const welcomeMessage: Message = {
        id: 'welcome',
        type: 'system',
        content: '🏠 Welcome to Dome AI Assistant! Type your question or use commands like /help, /list, /status.',
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
  }, [addActivity]);

  // Update indexing status with optimized frequency
  useEffect(() => {
    const updateStatus = () => {
      const status = backgroundIndexer.getStatus();
      setIndexingStatus(prev => {
        // Only update if status actually changed to prevent unnecessary renders
        if (prev.isRunning !== status.isRunning ||
          prev.isIndexing !== status.isIndexing ||
          Math.abs(prev.lastIndexTime - status.lastIndexTime) > 60000) { // Only update time if >1min difference
          return status;
        }
        return prev;
      });
    };

    updateStatus();
    const interval = setInterval(updateStatus, 10000); // Reduce frequency even more for less flicker

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
    if (key.ctrl && input === 'a') {
      setShowActivity(!showActivity);
    }
    
    // Navigation for message selection
    if (key.upArrow) {
      setSelectedMessageIndex(prev => {
        const assistantMessages = messages.filter(m => m.type === 'assistant');
        if (assistantMessages.length === 0) return -1;
        if (prev === -1) return messages.indexOf(assistantMessages[assistantMessages.length - 1]);
        const currentIdx = messages.indexOf(messages[prev]);
        for (let i = currentIdx - 1; i >= 0; i--) {
          if (messages[i].type === 'assistant') return i;
        }
        return prev;
      });
    }
    
    if (key.downArrow) {
      setSelectedMessageIndex(prev => {
        if (prev === -1) return -1;
        const assistantMessages = messages.filter(m => m.type === 'assistant');
        if (assistantMessages.length === 0) return -1;
        for (let i = prev + 1; i < messages.length; i++) {
          if (messages[i].type === 'assistant') return i;
        }
        return prev;
      });
    }
    
    // Toggle collapse with 's'
    if (input === 's' && selectedMessageIndex !== -1) {
      const message = messages[selectedMessageIndex];
      if (message && message.type === 'assistant' && message.content.length > 200) {
        setMessages(prev => prev.map((msg, idx) => 
          idx === selectedMessageIndex 
            ? { ...msg, isCollapsed: !msg.isCollapsed }
            : msg
        ));
      }
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

      // Track that we're using the notes agent
      addActivity('tool', 'Notes Agent');

      const response = await agent.generate([{ role: 'user', content: trimmedInput }]);

      // Analyze the response to detect tool usage and document references
      const responseText = response.text || '';
      const { tools, documents } = analyzeAgentResponse(responseText);
      
      // Track detected tool usage
      for (const tool of tools) {
        addActivity('tool', tool);
      }
      
      // Track detected document references
      for (const doc of documents) {
        addActivity('document', doc);
      }

      addMessage({
        type: 'assistant',
        content: responseText || 'I apologize, but I couldn\'t process your request. Please try rephrasing your question.'
      });
    } catch (error) {
      addMessage({
        type: 'error',
        content: `Error processing query: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    } finally {
      setIsProcessing(false);
    }
  }, [addMessage, addActivity]);

  const handleBuiltinCommand = useCallback(async (input: string): Promise<boolean> => {
    // Check if input starts with slash for commands
    if (!input.startsWith('/')) {
      // Check for common command typos without slash
      const commandWords = ['help', 'exit', 'quit', 'q', 'clear', 'list', 'status', 'index', 'quiet', 'verbose'];
      const firstWord = input.split(' ')[0].toLowerCase();
      if (commandWords.includes(firstWord)) {
        addMessage({
          type: 'system',
          content: `💡 Did you mean /${firstWord}? Commands now require a slash prefix to prevent accidental triggers.`
        });
      }
      return false;
    }

    const [command, ...args] = input.slice(1).split(' '); // Remove the slash

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
          content: '🏠 Welcome back to Dome AI Assistant! Use /help for available commands.'
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
        // Check for :timestamps command
        if (input.startsWith(':timestamps')) {
          const mode = args[0];
          if (mode === 'on' || mode === 'relative') {
            setTimestampMode('relative');
            addMessage({
              type: 'system',
              content: 'Timestamps enabled (relative format)'
            });
          } else if (mode === 'absolute') {
            setTimestampMode('absolute');
            addMessage({
              type: 'system',
              content: 'Timestamps enabled (absolute format)'
            });
          } else if (mode === 'off') {
            setTimestampMode('off');
            addMessage({
              type: 'system',
              content: 'Timestamps disabled'
            });
          } else {
            addMessage({
              type: 'system',
              content: 'Usage: :timestamps [on|off|relative|absolute]'
            });
          }
          return true;
        }
        return false;
    }
  }, [addMessage, showHelp, exit]);

  const handleListCommand = useCallback(async () => {
    try {
      addActivity('tool', 'listNotes');
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
  }, [addMessage, addActivity]);

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
      />

      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <Box flexGrow={1}>
            <ChatHistory 
              messages={messages} 
              isProcessing={isProcessing} 
              timestampMode={timestampMode}
              selectedMessageIndex={selectedMessageIndex}
            />
          </Box>
          <InputArea onSubmit={handleUserInput} isDisabled={isProcessing} />
        </Box>

        {showHelp && (
          <Box width={35} borderStyle="single" borderColor="blue" paddingX={1}>
            <HelpPanel />
          </Box>
        )}
        
        {showActivity && (
          <Box width={35} borderStyle="single" borderColor="magenta" paddingX={1}>
            <ActivityPanel activities={activities} />
          </Box>
        )}
      </Box>
      
      {indexingStatus.isRunning && (
        <BottomStatusBar indexingStatus={indexingStatus} />
      )}
    </Box>
  );
};

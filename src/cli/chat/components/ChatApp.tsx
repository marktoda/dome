import React, { useEffect, useCallback, useState } from 'react';
import { Box, useApp } from 'ink';
import { StatusBar } from './StatusBar.js';
import { ChatHistory } from './ChatHistory.js';
import { InputArea } from './InputArea.js';
import { HelpPanel } from './HelpPanel.js';
import { BottomStatusBar } from './BottomStatusBar.js';
import { ActivityPanel } from './ActivityPanel.js';
import { FullscreenLayout } from './FullscreenLayout.js';
import { mastra } from '../../../mastra/index.js';
import { backgroundIndexer } from '../../../mastra/core/search.js';
import { listNotes } from '../../../mastra/core/notes.js';
import { setActivityTracker, analyzeAgentResponse } from '../utils/activityTracker.js';
import { AppProvider, useAppState, useChatState, useUIState, useIndexingState } from '../state/AppContext.js';
import { useVaultIndexer } from '../hooks/useVaultIndexer.js';
import { COLORS, LAYOUT, STREAMING } from '../constants.js';
import { ChatMessage } from '../state/types.js';
import { withRetry, createErrorMessage, isRetryableError } from '../utils/errorHandler.js';
import { useGlobalShortcuts } from '../hooks/useGlobalShortcuts.js';

// Types are now imported from state/types.ts

const ChatAppInner: React.FC = () => {
  const { state, dispatch } = useAppState();
  const chat = useChatState();
  const ui = useUIState();
  const indexingStatus = useIndexingState();
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);

  const { exit } = useApp();

  const addActivity = useCallback((type: 'tool' | 'document', name: string) => {
    dispatch({ type: 'ADD_ACTIVITY', payload: { type, name } });
  }, [dispatch]);

  // Initialize the app
  useEffect(() => {
    const initialize = async () => {
      const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
      dispatch({ type: 'SET_VAULT_PATH', payload: vaultPath });
      
      // Set up the global activity tracker
      setActivityTracker({ addActivity });

      dispatch({ 
        type: 'ADD_MESSAGE', 
        payload: {
          type: 'system',
          content: '# 🏠 Welcome to Dome AI Assistant!\n\nType your question or use commands like `/help`, `/list`, `/status`.\n\n*Activity monitor is enabled. Press Ctrl+A to toggle.*'
        }
      });

      // Load notes count
      try {
        const notes = await listNotes();
        dispatch({ type: 'SET_NOTE_COUNT', payload: notes.length });
      } catch {
        dispatch({ type: 'SET_NOTE_COUNT', payload: 0 });
      }

      // Background indexing is now handled by useVaultIndexer hook
    };

    initialize();

    return () => {
      // Cleanup handled by useVaultIndexer
    };
  }, [addActivity]);

  // Use worker-based indexing
  useVaultIndexer(state.header.vaultPath || process.env.DOME_VAULT_PATH || `${process.env.HOME}/dome`);

  // Global keyboard shortcuts
  useGlobalShortcuts(chat, dispatch, exit);

  const addMessage = useCallback((message: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    dispatch({ type: 'ADD_MESSAGE', payload: message });
  }, [dispatch]);

  const handleUserInput = useCallback(async (input: string) => {
    const trimmedInput = input.trim();
    if (!trimmedInput) return;

    addMessage({ type: 'user', content: trimmedInput });

    if (await handleBuiltinCommand(trimmedInput)) {
      return;
    }

    setIsProcessing(true);
    
    // Create a new assistant message that we'll update as we stream
    const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    dispatch({ 
      type: 'ADD_MESSAGE', 
      payload: { 
        type: 'assistant', 
        content: '', 
        isStreaming: true,
        id: messageId,
        timestamp: new Date()
      } 
    });
    
    // Small delay to ensure React updates
    await new Promise(resolve => setTimeout(resolve, 10));
    
    try {
      // Get context-aware agent based on current working directory
      const agent = await mastra.getAgent("notesAgent");

      // Track that we're using the notes agent
      addActivity('tool', 'Notes Agent');

      // Set up streaming for character-by-character display
      setCurrentMessageId(messageId);
      
      // Use streaming with retry for network errors
      const stream = await withRetry(
        async () => agent.stream([{ role: 'user', content: trimmedInput }]),
        { maxRetries: 2 }
      );
      
      let fullResponse = '';
      let lastAnalyzedLength = 0;
      const detectedTools = new Set<string>();
      const detectedDocs = new Set<string>();
      
      // Prepare buffered appending to minimise rerenders
      let buffer = '';
      let flushTimeout: NodeJS.Timeout | null = null;
      const flushBuffer = () => {
        if (buffer) {
          dispatch({
            type: 'APPEND_TO_MESSAGE',
            payload: { id: messageId, content: buffer }
          });
          buffer = '';
        }
      };

      // Process the stream
      for await (const chunk of stream.textStream) {
        fullResponse += chunk;
        buffer += chunk;

        // Schedule a buffered flush ~20fps (50 ms)
        if (!flushTimeout) {
          flushTimeout = setTimeout(() => {
            flushBuffer();
            flushTimeout = null;
          }, STREAMING.FLUSH_INTERVAL_MS);
        }
        
        // Analyze new content for tool usage every 100 characters
        if (fullResponse.length - lastAnalyzedLength > 100) {
          const newContent = fullResponse.substring(lastAnalyzedLength);
          const { tools, documents } = analyzeAgentResponse(newContent);
          
          // Track newly detected tools
          for (const tool of tools) {
            if (!detectedTools.has(tool)) {
              detectedTools.add(tool);
              addActivity('tool', tool);
            }
          }
          
          // Track newly detected documents
          for (const doc of documents) {
            if (!detectedDocs.has(doc)) {
              detectedDocs.add(doc);
              addActivity('document', doc);
            }
          }
          
          lastAnalyzedLength = fullResponse.length;
        }
      }

      // Flush any remaining buffered text
      flushBuffer();

      // Ensure all characters are displayed
      dispatch({
        type: 'FINISH_STREAMING',
        payload: { id: messageId }
      });
      setCurrentMessageId(null);
      
      // Do a final analysis on the complete response to catch anything missed
      const { tools: finalTools, documents: finalDocs } = analyzeAgentResponse(fullResponse);
      
      // Track any remaining tools not caught during streaming
      for (const tool of finalTools) {
        if (!detectedTools.has(tool)) {
          addActivity('tool', tool);
        }
      }
      
      // Track any remaining documents not caught during streaming
      for (const doc of finalDocs) {
        if (!detectedDocs.has(doc)) {
          addActivity('document', doc);
        }
      }
      
      // If no content was streamed, show error message
      if (!fullResponse) {
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: { 
            id: messageId, 
            content: 'I apologize, but I couldn\'t process your request. Please try rephrasing your question.',
            isStreaming: false
          }
        });
      }
    } catch (error) {
      // Stop streaming if active
      if (currentMessageId) {
        dispatch({
          type: 'FINISH_STREAMING',
          payload: { id: messageId }
        });
        setCurrentMessageId(null);
      }
      
      const errorMessage = createErrorMessage(error, 'Failed to process query');
      
      // Update the message with error
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: { 
          id: messageId, 
          content: errorMessage,
          isStreaming: false
        }
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
        dispatch({ 
          type: 'ADD_MESSAGE', 
          payload: {
            type: 'system',
            content: `💡 Did you mean /${firstWord}? Commands now require a slash prefix to prevent accidental triggers.`
          }
        });
      }
      return false;
    }

    const [command, ...args] = input.slice(1).split(' '); // Remove the slash

    switch (command.toLowerCase()) {
      case 'help':
        dispatch({ type: 'TOGGLE_HELP' });
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
        dispatch({ type: 'CLEAR_MESSAGES' });
        dispatch({ 
          type: 'ADD_MESSAGE', 
          payload: {
            type: 'system',
            content: '🏠 Welcome back to Dome AI Assistant! Use /help for available commands.'
          }
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
            dispatch({ type: 'SET_TIMESTAMP_MODE', payload: 'relative' });
            dispatch({ 
              type: 'ADD_MESSAGE', 
              payload: {
                type: 'system',
                content: 'Timestamps enabled (relative format)'
              }
            });
          } else if (mode === 'absolute') {
            dispatch({ type: 'SET_TIMESTAMP_MODE', payload: 'absolute' });
            dispatch({ 
              type: 'ADD_MESSAGE', 
              payload: {
                type: 'system',
                content: 'Timestamps enabled (absolute format)'
              }
            });
          } else if (mode === 'off') {
            dispatch({ type: 'SET_TIMESTAMP_MODE', payload: 'off' });
            dispatch({ 
              type: 'ADD_MESSAGE', 
              payload: {
                type: 'system',
                content: 'Timestamps disabled'
              }
            });
          } else {
            dispatch({ 
              type: 'ADD_MESSAGE', 
              payload: {
                type: 'system',
                content: 'Usage: :timestamps [on|off|relative|absolute]'
              }
            });
          }
          return true;
        }
        return false;
    }
  }, [dispatch, exit]);

  const handleListCommand = useCallback(async () => {
    try {
      addActivity('tool', 'listNotes');
      const notes = await withRetry(() => listNotes(), { maxRetries: 1 });

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

      let content = `## 📚 ${notes.length} notes\n\n`;

      for (const note of recentNotes) {
        const timeAgo = formatTimeAgo(new Date(note.date));
        content += `- **${note.title}** *(${timeAgo})*\n`;
      }

      if (notes.length > 10) {
        content += `\n*... and ${notes.length - 10} more notes*`;
      }

      dispatch({ 
        type: 'ADD_MESSAGE', 
        payload: {
          type: 'system',
          content
        }
      });
    } catch (error) {
      dispatch({ 
        type: 'ADD_MESSAGE', 
        payload: {
          type: 'error',
          content: `Failed to list notes: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      });
    }
  }, [dispatch, addActivity]);

  const handleStatusCommand = useCallback(() => {
    const status = backgroundIndexer.getStatus();
    let content = '## 🔍 Background Indexing Status\n\n';
    content += `- **Running:** ${status.isRunning ? '✅ Yes' : '❌ No'}\n`;
    content += `- **Currently indexing:** ${status.isIndexing ? '🔄 Yes' : '✅ No'}\n`;

    if (status.lastIndexTime > 0) {
      const lastIndexDate = new Date(status.lastIndexTime);
      const timeAgo = formatTimeAgo(lastIndexDate);
      content += `- **Last indexed:** ${timeAgo}`;
    } else {
      content += '- **Last indexed:** Never';
    }

    dispatch({ 
      type: 'ADD_MESSAGE', 
      payload: {
        type: 'system',
        content
      }
    });
  }, [dispatch]);

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

  // Prepare sidebar content
  const leftSidebar = ui.showHelp ? (
    <Box borderStyle="single" borderColor={COLORS.border.help} paddingX={1} height="100%">
      <HelpPanel />
    </Box>
  ) : undefined;
  
  const rightSidebar = ui.showActivity ? (
    <Box borderStyle="single" borderColor={COLORS.border.activity} paddingX={1} height="100%">
      <ActivityPanel activities={state.activity} />
    </Box>
  ) : undefined;

  return (
    <FullscreenLayout
      header={
        <StatusBar
          vaultPath={state.header.vaultPath}
          notesCount={state.header.noteCount}
        />
      }
      content={
        <Box flexDirection="column" height="100%">
          <Box flexGrow={1}>
            <ChatHistory 
              messages={chat.messages} 
              timestampMode={state.cfg.timestamps}
              selectedMessageIndex={chat.selectedIdx ?? -1}
            />
          </Box>
          <InputArea onSubmit={handleUserInput} isDisabled={isProcessing} />
        </Box>
      }
      leftSidebar={leftSidebar}
      rightSidebar={rightSidebar}
      footer={indexingStatus.running ? <BottomStatusBar indexingStatus={indexingStatus} /> : undefined}
    />
  );
};

// Export the wrapped component
export const ChatApp: React.FC = () => {
  return (
    <AppProvider>
      <ChatAppInner />
    </AppProvider>
  );
};

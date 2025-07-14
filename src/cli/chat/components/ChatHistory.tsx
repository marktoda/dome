import React, { useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ChatMessage } from '../state/types.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { COLORS, STREAMING, LIMITS } from '../constants.js';

interface ChatHistoryProps {
  messages: ChatMessage[];
  isProcessing: boolean;
  timestampMode: 'off' | 'relative' | 'absolute';
  selectedMessageIndex: number;
}

export const ChatHistory = React.memo<ChatHistoryProps>(({ messages, isProcessing, timestampMode, selectedMessageIndex }) => {
  const [showCursor, setShowCursor] = useState(true);
  
  // Blinking cursor effect
  useEffect(() => {
    if (isProcessing) {
      const interval = setInterval(() => {
        setShowCursor(prev => !prev);
      }, 500);
      return () => clearInterval(interval);
    }
  }, [isProcessing]);
  
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const formatRelativeTime = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
      return 'just now';
    } else if (diffMinutes < 60) {
      return `${diffMinutes}m ago`;
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else {
      return `${diffDays}d ago`;
    }
  };

  const getTimestamp = (date: Date) => {
    if (timestampMode === 'off') return '';
    if (timestampMode === 'absolute') return formatTime(date);
    return formatRelativeTime(date);
  };

  const getMessageColor = (type: ChatMessage['type']) => {
    switch (type) {
      case 'user':
        return COLORS.you;
      case 'assistant':
        return COLORS.dome;
      case 'system':
        return COLORS.system;
      case 'error':
        return COLORS.error;
      default:
        return COLORS.white;
    }
  };

  const getMessagePrefix = (type: ChatMessage['type']) => {
    switch (type) {
      case 'user':
        return '[You]    ';
      case 'assistant':
        return '[Dome]   ';
      case 'system':
        return '[System] ';
      case 'error':
        return '[Error]  ';
      default:
        return '';
    }
  };

  const messageElements = useMemo(() => 
    messages.map((message, index) => {
      const timestamp = getTimestamp(message.timestamp);
      const isSelected = index === selectedMessageIndex;
      const isLong = message.content.length > LIMITS.COLLAPSE_THRESHOLD;
      const canCollapse = message.type === 'assistant' && isLong;
      
      let displayContent = message.content;
      if (message.isCollapsed && canCollapse) {
        const preview = message.content.substring(0, 80).replace(/\n/g, ' ');
        displayContent = `${preview}... [${message.content.length} chars, press 's' to expand]`;
      }
      
      return (
        <Box 
          key={message.id}
          flexDirection="column"
          marginBottom={1}
          borderStyle={isSelected && canCollapse ? 'single' : undefined}
          borderColor={isSelected ? 'yellow' : undefined}
        >
          <Box flexDirection="column">
            <Box marginBottom={message.type === 'assistant' ? 1 : 0}>
              <Text color={getMessageColor(message.type)} bold>{getMessagePrefix(message.type)}</Text>
              {timestamp && <Text color="gray"> {timestamp}</Text>}
            </Box>
            {(message.type === 'assistant' || message.type === 'system') && !message.isCollapsed ? (
              <Box>
                <MarkdownRenderer content={displayContent} color={message.type === 'system' ? 'blue' : 'white'} />
                {message.type === 'assistant' && message.isStreaming && index === messages.length - 1 && showCursor && (
                  <Text color={COLORS.you}>{STREAMING.CURSOR}</Text>
                )}
              </Box>
            ) : (
              <Text color={message.type === 'error' ? 'red' : undefined}>{displayContent}</Text>
            )}
            {canCollapse && !message.isCollapsed && isSelected && (
              <Box marginTop={1}>
                <Text color="yellow">[press 's' to collapse]</Text>
              </Box>
            )}
          </Box>
        </Box>
      );
    }), [messages, timestampMode, selectedMessageIndex, showCursor]
  );

  // Only show the most recent messages that fit in the available space
  // This creates a scrolling effect where old messages disappear at the top
  const visibleMessages = messageElements.slice(-LIMITS.MAX_MESSAGES); // Keep last messages in memory
  
  return (
    <Box 
      flexDirection="column" 
      flexGrow={1} 
      paddingX={1}
      paddingY={1}
      overflow="hidden"
    >
      {visibleMessages}
    </Box>
  );
});

ChatHistory.displayName = 'ChatHistory';
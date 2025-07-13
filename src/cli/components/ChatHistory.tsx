import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Message } from './ChatApp.js';

interface ChatHistoryProps {
  messages: Message[];
  isProcessing: boolean;
  timestampMode: 'off' | 'relative' | 'absolute';
  selectedMessageIndex: number;
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({ messages, isProcessing, timestampMode, selectedMessageIndex }) => {
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

  const getMessageColor = (type: Message['type']) => {
    switch (type) {
      case 'user':
        return 'cyan';
      case 'assistant':
        return 'magenta';
      case 'system':
        return 'blue';
      case 'error':
        return 'red';
      default:
        return 'white';
    }
  };

  const getMessagePrefix = (type: Message['type']) => {
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
      const isLong = message.content.length > 200;
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
          <Box>
            <Text color={getMessageColor(message.type)} bold>{getMessagePrefix(message.type)}</Text>
            <Text>{displayContent}</Text>
            {timestamp && <Text color="gray"> {timestamp}</Text>}
            {canCollapse && !message.isCollapsed && isSelected && (
              <Text color="yellow"> [press 's' to collapse]</Text>
            )}
          </Box>
        </Box>
      );
    }), [messages, timestampMode, selectedMessageIndex]
  );

  return (
    <Box 
      flexDirection="column" 
      flexGrow={1} 
      paddingX={1}
      paddingY={1}
      minHeight={0}
    >
      {messageElements}
      
      {isProcessing && (
        <Box marginBottom={1}>
          <Text color="magenta" bold>[Dome]   </Text>
          <Text color="yellow">Thinking...</Text>
        </Box>
      )}
    </Box>
  );
};
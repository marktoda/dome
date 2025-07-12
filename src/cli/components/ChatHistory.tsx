import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Message } from './ChatApp.js';

interface ChatHistoryProps {
  messages: Message[];
  isProcessing: boolean;
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({ messages, isProcessing }) => {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const getMessageColor = (type: Message['type']) => {
    switch (type) {
      case 'user':
        return 'cyan';
      case 'assistant':
        return 'white';
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
        return '👤';
      case 'assistant':
        return '🤖';
      case 'system':
        return 'ℹ️';
      case 'error':
        return '❌';
      default:
        return '';
    }
  };

  const messageElements = useMemo(() => 
    messages.map((message) => (
      <Box key={message.id}>
        <Text color={getMessageColor(message.type)}>
          {getMessagePrefix(message.type)} {message.content}
        </Text>
      </Box>
    )), [messages]
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
        <Box>
          <Text color="yellow">🤖 Thinking...</Text>
        </Box>
      )}
    </Box>
  );
};
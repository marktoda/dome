import React from 'react';
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

  return (
    <Box 
      flexDirection="column" 
      flexGrow={1} 
      paddingX={1}
      borderStyle="single"
      borderColor="gray"
    >
      {messages.map((message) => (
        <Box key={message.id} marginBottom={1}>
          <Box minWidth={8}>
            <Text dimColor>[{formatTime(message.timestamp)}]</Text>
          </Box>
          <Box marginLeft={1}>
            <Text>{getMessagePrefix(message.type)}</Text>
          </Box>
          <Box marginLeft={1} flexDirection="column">
            <Text color={getMessageColor(message.type)}>
              {message.content}
            </Text>
          </Box>
        </Box>
      ))}
      
      {isProcessing && (
        <Box marginBottom={1}>
          <Box minWidth={8}>
            <Text dimColor>[{formatTime(new Date())}]</Text>
          </Box>
          <Box marginLeft={1}>
            <Text>🤖</Text>
          </Box>
          <Box marginLeft={1}>
            <Text color="yellow">Thinking...</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
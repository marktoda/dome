import React from 'react';
import { Box, Text } from 'ink';
import { IndexingStatus } from './ChatApp.js';

interface StatusBarProps {
  vaultPath: string;
  notesCount: number;
  indexingStatus: IndexingStatus;
}

export const StatusBar: React.FC<StatusBarProps> = ({ 
  vaultPath, 
  notesCount, 
  indexingStatus 
}) => {
  const getIndexingIndicator = () => {
    if (!indexingStatus.isRunning) {
      return <Text color="red">●</Text>;
    }
    
    if (indexingStatus.isIndexing) {
      return <Text color="yellow">●</Text>;
    }
    
    return <Text color="green">●</Text>;
  };

  const getIndexingText = () => {
    if (!indexingStatus.isRunning) {
      return 'Indexing: Stopped';
    }
    
    if (indexingStatus.isIndexing) {
      return 'Indexing: In Progress';
    }
    
    return 'Indexing: Ready';
  };

  const formatPath = (path: string) => {
    if (path.startsWith(process.env.HOME || '')) {
      return path.replace(process.env.HOME || '', '~');
    }
    return path;
  };

  return (
    <Box 
      borderStyle="single" 
      borderColor="blue" 
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text bold color="blue">🏠 Dome AI Assistant</Text>
        <Text> - </Text>
        <Text>{formatPath(vaultPath)}</Text>
        <Text> ({notesCount} notes)</Text>
      </Box>
      
      <Box>
        {getIndexingIndicator()}
        <Text> {getIndexingText()}</Text>
      </Box>
    </Box>
  );
};
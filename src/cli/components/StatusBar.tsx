import React, { useMemo } from 'react';
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
  const { indicator, text } = useMemo(() => {
    if (!indexingStatus.isRunning) {
      return {
        indicator: <Text color="red">●</Text>,
        text: 'Indexing: Stopped'
      };
    }
    
    if (indexingStatus.isIndexing) {
      return {
        indicator: <Text color="yellow">●</Text>,
        text: 'Indexing: In Progress'
      };
    }
    
    return {
      indicator: <Text color="green">●</Text>,
      text: 'Indexing: Ready'
    };
  }, [indexingStatus.isRunning, indexingStatus.isIndexing]);

  const formattedPath = useMemo(() => {
    const home = process.env.HOME || '';
    return vaultPath.startsWith(home) ? vaultPath.replace(home, '~') : vaultPath;
  }, [vaultPath]);

  return (
    <Box 
      borderStyle="single" 
      borderColor="blue" 
      paddingX={1}
      justifyContent="space-between"
    >
      <Box>
        <Text bold color="blue">🏠 Dome AI Assistant</Text>
        <Text> - {formattedPath} ({notesCount} notes)</Text>
      </Box>
      
      <Box>
        {indicator}
        <Text> {text}</Text>
      </Box>
    </Box>
  );
};
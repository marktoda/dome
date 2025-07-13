import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  vaultPath: string;
  notesCount: number;
}

export const StatusBar = React.memo<StatusBarProps>(({ 
  vaultPath, 
  notesCount
}) => {

  const formattedPath = useMemo(() => {
    const home = process.env.HOME || '';
    return vaultPath.startsWith(home) ? vaultPath.replace(home, '~') : vaultPath;
  }, [vaultPath]);

  return (
    <Box 
      borderStyle="single" 
      borderColor="blue" 
      paddingX={1}
    >
      <Text bold color="blue">🏠 Dome AI Assistant</Text>
      <Text> - {formattedPath} ({notesCount} notes)</Text>
    </Box>
  );
});
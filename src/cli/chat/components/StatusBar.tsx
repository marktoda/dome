import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../constants.js';

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
    <Box paddingX={1}>
      <Text bold color={COLORS.system}>🏠 Dome AI Assistant</Text>
      <Text> - {formattedPath} ({notesCount} notes)</Text>
    </Box>
  );
});
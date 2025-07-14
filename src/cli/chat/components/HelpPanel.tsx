import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../constants.js';

export const HelpPanel = React.memo(() => {
  return (
    <Box flexDirection="column">
      <Text bold color={COLORS.system}>Help</Text>
      <Text> </Text>
      
      <Text bold>Commands:</Text>
      <Text>/help, /list, /status, /clear</Text>
      <Text>/exit, /quit, /q</Text>
      <Text>/quiet, /verbose</Text>
      <Text>:timestamps on/off/relative/absolute</Text>
      <Text> </Text>
      
      <Text bold>Shortcuts:</Text>
      <Text>Ctrl+C - Exit</Text>
      <Text>Ctrl+H - Toggle help</Text>
      <Text>Ctrl+A - Toggle activity</Text>
      <Text>↑/↓ - Navigate messages</Text>
      <Text>s - Collapse/expand message</Text>
      <Text> </Text>
      
      <Text bold>AI Features:</Text>
      <Text>Ask about notes</Text>
      <Text>Summarize content</Text>
      <Text>Search topics</Text>
    </Box>
  );
});

HelpPanel.displayName = 'HelpPanel';
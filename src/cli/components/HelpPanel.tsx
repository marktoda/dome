import React from 'react';
import { Box, Text } from 'ink';

export const HelpPanel: React.FC = () => {
  return (
    <Box flexDirection="column">
      <Text bold color="blue">Help</Text>
      <Text> </Text>
      
      <Text bold>Commands:</Text>
      <Text>help, list, status, clear</Text>
      <Text>exit/quit/q</Text>
      <Text> </Text>
      
      <Text bold>Shortcuts:</Text>
      <Text>Ctrl+C - Exit</Text>
      <Text>Ctrl+H - Toggle help</Text>
      <Text> </Text>
      
      <Text bold>AI Features:</Text>
      <Text>Ask about notes</Text>
      <Text>Summarize content</Text>
      <Text>Search topics</Text>
    </Box>
  );
};
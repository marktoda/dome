import React from 'react';
import { Box, Text } from 'ink';

export const HelpPanel: React.FC = () => {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">📖 Help</Text>
      <Text> </Text>
      
      <Text bold color="yellow">Commands:</Text>
      <Text>help - Show/hide this help</Text>
      <Text>list - List all notes</Text>
      <Text>status - Show indexing status</Text>
      <Text>clear - Clear chat history</Text>
      <Text>quiet - Disable index logs</Text>
      <Text>verbose - Enable index logs</Text>
      <Text>exit/quit/q - Exit app</Text>
      <Text> </Text>
      
      <Text bold color="yellow">Shortcuts:</Text>
      <Text>Ctrl+C - Exit</Text>
      <Text>Ctrl+H - Toggle help</Text>
      <Text>Enter - Send message</Text>
      <Text> </Text>
      
      <Text bold color="yellow">AI Features:</Text>
      <Text>• Ask about your notes</Text>
      <Text>• Summarize content</Text>
      <Text>• Create/append notes</Text>
      <Text>• Search topics</Text>
      <Text>• Generate todo lists</Text>
      <Text> </Text>
      
      <Text bold color="yellow">Examples:</Text>
      <Text dimColor>"summarize my meeting notes"</Text>
      <Text dimColor>"find notes about features"</Text>
      <Text dimColor>"create a todo list"</Text>
      <Text dimColor>"what did I write about X?"</Text>
    </Box>
  );
};
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../constants.js';
import { KeybindingManager } from '../keybindings/index.js';
import { ChatCommandRegistryImpl } from '../commands/index.js';

interface HelpPanelProps {
  keybindingManager?: KeybindingManager;
  commandRegistry?: ChatCommandRegistryImpl;
}

export const HelpPanel = React.memo<HelpPanelProps>(({ keybindingManager, commandRegistry }) => {
  // Generate dynamic help text from registries
  const keybindingHelp = keybindingManager?.generateHelpText() || getDefaultKeybindingHelp();
  const commandHelp = commandRegistry?.generateHelp() || getDefaultCommandHelp();

  return (
    <Box flexDirection="column">
      <Text bold color={COLORS.system}>
        Help
      </Text>
      <Text> </Text>

      <Text>{commandHelp}</Text>
      <Text> </Text>
      
      <Text>{keybindingHelp}</Text>
      <Text> </Text>

      <Text bold>AI Features:</Text>
      <Text>Ask about notes</Text>
      <Text>Summarize content</Text>
      <Text>Search topics</Text>
    </Box>
  );
});

// Fallback help text if registries are not available
function getDefaultKeybindingHelp(): string {
  return `Keyboard Shortcuts:

Application:
  Ctrl+C - Exit

UI:
  Ctrl+H - Toggle help
  Ctrl+A - Toggle activity/note log

Note Log:
  Ctrl+J/↓ - Select next note
  Ctrl+K/↑ - Select previous note
  Tab - Open selected note

Messages:
  ↑/↓ - Navigate messages
  s - Toggle collapse/expand`;
}

function getDefaultCommandHelp(): string {
  return `Commands:
  
Core:
  /help (/h, /?) - Show this help
  /exit (/quit, /q) - Exit the chat
  /clear (/cls) - Clear chat history

Notes:
  /list (/ls) [limit] - List recent notes
  /search (/find, /s) <query> - Search for notes

Status:
  /status (/info) - Show indexing status

Settings:
  /timestamps (/ts) [off|relative|absolute] - Toggle timestamp display
  /verbose - Toggle verbose mode
  /quiet - Disable verbose mode`;
}

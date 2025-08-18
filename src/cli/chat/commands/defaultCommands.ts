import { ChatCommand } from './types.js';
import { NoteService } from '../../../core/services/NoteService.js';
import { createNoOpEventBus } from '../../../core/events/index.js';

export const defaultChatCommands: ChatCommand[] = [
  // === Core Commands ===
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands',
    group: 'Core',
    handler: async (args, context) => {
      // This will be implemented by the registry
      context.showHelp();
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the chat',
    group: 'Core',
    handler: async (args, context) => {
      context.exit();
    },
  },
  {
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear chat history',
    group: 'Core',
    handler: async (args, context) => {
      context.clearMessages();
      context.addMessage({
        type: 'system',
        content: 'Chat history cleared.',
      });
    },
  },

  // === Note Commands ===
  {
    name: 'list',
    aliases: ['ls'],
    description: 'List recent notes',
    usage: '[limit]',
    group: 'Notes',
    handler: async (args, context) => {
      const noteService = new NoteService(createNoOpEventBus());
      const limit = args[0] ? parseInt(args[0], 10) : 10;

      try {
        const allNotes = await noteService.listNotes();

        // Sort by modification time (would need stats for this, for now just show first N)
        const notes = allNotes.slice(0, limit);

        if (notes.length === 0) {
          context.addMessage({
            type: 'system',
            content: 'No notes found.',
          });
          return;
        }

        const noteList = notes.map((note, index) => `${index + 1}. ${note.path}`).join('\n');

        context.addMessage({
          type: 'system',
          content: `Recent notes (showing ${notes.length} of ${allNotes.length}):\n\n${noteList}`,
        });
      } catch (error) {
        context.addMessage({
          type: 'error',
          content: `Failed to list notes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    },
  },
  {
    name: 'search',
    aliases: ['find', 's'],
    description: 'Search for notes',
    usage: '<query>',
    group: 'Notes',
    handler: async (args, context) => {
      if (args.length === 0) {
        context.addMessage({
          type: 'error',
          content: 'Please provide a search query.',
        });
        return;
      }

      const query = args.join(' ');
      context.addMessage({
        type: 'system',
        content: `Searching for "${query}"...`,
      });

      // The actual search will be handled by the AI agent
      // This is just a placeholder to show the command structure
    },
  },

  // === Status Commands ===
  {
    name: 'status',
    aliases: ['info'],
    description: 'Show indexing status',
    group: 'Status',
    handler: async (args, context) => {
      const state = context.getState();
      const { index, header } = state;

      let statusMessage = `Vault: ${header.vaultPath}\n`;
      statusMessage += `Notes: ${header.noteCount}\n`;

      if (index.isIndexing) {
        statusMessage += `\nIndexing: ${index.progress}% complete`;
      } else if (index.lastIndexTime) {
        const lastIndex = new Date(index.lastIndexTime);
        statusMessage += `\nLast indexed: ${lastIndex.toLocaleString()}`;
      } else {
        statusMessage += `\nNot indexed yet`;
      }

      context.addMessage({
        type: 'system',
        content: statusMessage,
      });
    },
  },

  // === Settings Commands ===
  {
    name: 'timestamps',
    aliases: ['ts'],
    description: 'Toggle timestamp display',
    usage: '[off|relative|absolute]',
    group: 'Settings',
    handler: async (args, context) => {
      const validModes = ['off', 'relative', 'absolute'];
      const mode = args[0]?.toLowerCase();

      if (!mode) {
        context.addMessage({
          type: 'system',
          content: 'Timestamp modes: off, relative, absolute',
        });
        return;
      }

      if (!validModes.includes(mode)) {
        context.addMessage({
          type: 'error',
          content: `Invalid mode. Use one of: ${validModes.join(', ')}`,
        });
        return;
      }

      context.toggleTimestamps(mode as 'off' | 'relative' | 'absolute');
      context.addMessage({
        type: 'system',
        content: `Timestamps set to: ${mode}`,
      });
    },
  },
  {
    name: 'verbose',
    description: 'Toggle verbose mode',
    group: 'Settings',
    handler: async (args, context) => {
      const state = context.getState();
      const newVerbose = !state.cfg.verbose;

      // This would need to be implemented in the actual app
      context.addMessage({
        type: 'system',
        content: `Verbose mode: ${newVerbose ? 'ON' : 'OFF'}`,
      });
    },
  },
  {
    name: 'quiet',
    description: 'Disable verbose mode',
    group: 'Settings',
    hidden: true, // Hide from help since verbose covers both
    handler: async (args, context) => {
      context.addMessage({
        type: 'system',
        content: 'Verbose mode: OFF',
      });
    },
  },

  // === Development Commands ===
  {
    name: 'debug',
    description: 'Show debug information',
    group: 'Development',
    hidden: process.env.NODE_ENV === 'production',
    handler: async (args, context) => {
      const state = context.getState();
      const debugInfo = {
        messageCount: state.chat.messages.length,
        noteLogCount: state.noteLog?.length || 0,
        indexing: state.index.isIndexing,
        editorOpen: state.editorOpen,
      };

      context.addMessage({
        type: 'system',
        content: `Debug Info:\n${JSON.stringify(debugInfo, null, 2)}`,
      });
    },
  },
];

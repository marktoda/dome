import { Keybinding } from './types.js';

export const defaultKeybindings: Keybinding[] = [
  // === Application Control ===
  {
    id: 'app.exit',
    keys: { ctrl: true, key: 'c' },
    command: 'app.exit',
    description: 'Exit application',
    group: 'Application',
  },

  // === UI Toggles ===
  {
    id: 'ui.toggleHelp',
    keys: { ctrl: true, key: 'h' },
    command: 'ui.toggleHelp',
    when: '!editorOpen',
    description: 'Toggle help panel',
    group: 'UI',
  },
  {
    id: 'ui.toggleActivity',
    keys: { ctrl: true, key: 'a' },
    command: 'ui.toggleActivity',
    when: '!editorOpen',
    description: 'Toggle activity/note log panel',
    group: 'UI',
  },
  {
    id: 'ui.toggleDebug',
    keys: { ctrl: true, key: 'd' },
    command: 'ui.toggleDebug',
    when: '!editorOpen',
    description: 'Toggle debug log panel',
    group: 'UI',
  },

  // === Note Log Navigation ===
  {
    id: 'noteLog.selectNext',
    keys: { ctrl: true, key: 'j' },
    command: 'noteLog.selectNext',
    when: '!editorOpen && hasNoteLog && noteLogVisible',
    description: 'Select next note in log',
    group: 'Note Log',
  },
  {
    id: 'noteLog.selectNextArrow',
    keys: { ctrl: true, downArrow: true },
    command: 'noteLog.selectNext',
    when: '!editorOpen && hasNoteLog && noteLogVisible',
    description: 'Select next note in log',
    group: 'Note Log',
  },
  {
    id: 'noteLog.selectPrevious',
    keys: { ctrl: true, key: 'k' },
    command: 'noteLog.selectPrevious',
    when: '!editorOpen && hasNoteLog && noteLogVisible',
    description: 'Select previous note in log',
    group: 'Note Log',
  },
  {
    id: 'noteLog.selectPreviousArrow',
    keys: { ctrl: true, upArrow: true },
    command: 'noteLog.selectPrevious',
    when: '!editorOpen && hasNoteLog && noteLogVisible',
    description: 'Select previous note in log',
    group: 'Note Log',
  },
  {
    id: 'noteLog.openSelected',
    keys: { tab: true },
    command: 'noteLog.openSelected',
    when: '!editorOpen && !processing && hasNoteLog && noteLogVisible',
    description: 'Open selected note in editor',
    group: 'Note Log',
  },

  // === Chat Commands (Shortcuts) ===
  {
    id: 'chat.clear',
    keys: { ctrl: true, key: 'l' },
    command: 'chat.clear',
    when: '!editorOpen',
    description: 'Clear chat history',
    group: 'Chat',
  },
  {
    id: 'chat.showStatus',
    keys: { ctrl: true, key: 's' },
    command: 'chat.showStatus',
    when: '!editorOpen',
    description: 'Show indexing status',
    group: 'Chat',
  },

  // === Editor Quick Actions ===
  {
    id: 'editor.openNew',
    keys: { ctrl: true, key: 'n' },
    command: 'editor.openNew',
    when: '!editorOpen && !processing',
    description: 'Create new note',
    group: 'Editor',
  },
  {
    id: 'editor.openLast',
    keys: { ctrl: true, key: 'e' },
    command: 'editor.openLast',
    when: '!editorOpen && !processing',
    description: 'Open last edited note',
    group: 'Editor',
  },

  // === Scroll Support (for future scrollable areas) ===
  {
    id: 'scroll.pageUp',
    keys: { pageUp: true },
    command: 'scroll.pageUp',
    when: '!editorOpen',
    description: 'Scroll up one page',
    group: 'Navigation',
  },
  {
    id: 'scroll.pageDown',
    keys: { pageDown: true },
    command: 'scroll.pageDown',
    when: '!editorOpen',
    description: 'Scroll down one page',
    group: 'Navigation',
  },
];

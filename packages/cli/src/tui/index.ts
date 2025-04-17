#!/usr/bin/env node

import blessed from 'blessed';
import { createBaseLayout } from './layouts/BaseLayout';
import { ScreenManager } from './ScreenManager';
import { createDashboardScreen } from './screens/DashboardScreen';
import { createChatScreen } from './screens/ChatScreen';
import { createNotesScreen } from './screens/NotesScreen';
import { createSearchScreen } from './screens/SearchScreen';
import { createSettingsScreen } from './screens/SettingsScreen';
import { createHelpScreen } from './screens/HelpScreen';
import { loadConfig, isAuthenticated } from '../utils/config';
import { error } from '../utils/ui';

/**
 * Start the TUI
 */
export function startTui(): void {
  // Check if user is authenticated
  if (!isAuthenticated()) {
    console.log(error('You need to login first. Run `dome login` to authenticate.'));
    process.exit(1);
  }

  // Create the base layout
  const layout = createBaseLayout();

  // Create the screen manager
  const screenManager = new ScreenManager(layout);

  // Create and register screens
  const dashboardScreen = createDashboardScreen(layout);
  screenManager.registerScreen(dashboardScreen);

  const chatScreen = createChatScreen(layout);
  screenManager.registerScreen(chatScreen);

  const notesScreen = createNotesScreen(layout);
  screenManager.registerScreen(notesScreen);

  // Create a placeholder for tasks screen
  const tasksElement = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    content: 'Tasks functionality coming soon...',
    tags: true,
    hidden: true,
  });
  
  const tasksScreen = {
    id: 'tasks',
    title: 'Tasks',
    element: tasksElement,
  };
  screenManager.registerScreen(tasksScreen);

  const searchScreen = createSearchScreen(layout);
  screenManager.registerScreen(searchScreen);

  const settingsScreen = createSettingsScreen(layout);
  screenManager.registerScreen(settingsScreen);

  const helpScreen = createHelpScreen(layout);
  screenManager.registerScreen(helpScreen);

  // Initialize the screen manager
  screenManager.init();
}

// If this file is run directly, start the TUI
if (require.main === module) {
  startTui();
}
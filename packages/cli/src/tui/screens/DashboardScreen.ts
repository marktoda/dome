import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';

/**
 * Create the dashboard screen
 * @param layout The base layout elements
 * @returns The dashboard screen
 */
export function createDashboardScreen(layout: BaseLayoutElements): Screen {
  // Create the main container
  const element = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
  });

  // Create a grid for the dashboard components
  const grid = new contrib.grid({ 
    rows: 12, 
    cols: 12, 
    screen: layout.screen 
  });

  // Create a welcome message
  const welcomeBox = blessed.box({
    parent: element,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}Welcome to Dome CLI{/bold}{/center}\n{center}AI-powered personal memory assistant{/center}',
    tags: true,
    style: {
      fg: 'white',
    },
  });

  // Create a stats box
  const statsBox = blessed.box({
    parent: element,
    top: 3,
    left: 0,
    width: '50%',
    height: 7,
    content: '{bold}Your Stats{/bold}\n\n• Notes: 12\n• Tasks: 5\n• Chats: 3',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Create a recent activity box
  const recentActivityBox = blessed.box({
    parent: element,
    top: 3,
    right: 0,
    width: '50%',
    height: 7,
    content: '{bold}Recent Activity{/bold}\n\n• Added note "Meeting notes" (2 hours ago)\n• Completed task "Send email" (5 hours ago)\n• Chat session (yesterday)',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Create a quick actions box
  const quickActionsBox = blessed.box({
    parent: element,
    top: 10,
    left: 0,
    width: '100%',
    height: 5,
    content: '{bold}Quick Actions{/bold}\n\n• Press {bold}c{/bold} to start a new chat\n• Press {bold}n{/bold} to add a new note\n• Press {bold}t{/bold} to add a new task',
    tags: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Set up key bindings for quick actions
  layout.screen.key('c', () => {
    // This will be handled by the screen manager
    layout.sidebar.select(1); // Chat is at index 1
  });

  layout.screen.key('n', () => {
    // This will be handled by the screen manager
    layout.sidebar.select(2); // Notes is at index 2
  });

  layout.screen.key('t', () => {
    // This will be handled by the screen manager
    layout.sidebar.select(3); // Tasks is at index 3
  });

  return {
    id: 'dashboard',
    title: 'Dashboard',
    element,
    onFocus: () => {
      // Update stats and recent activity when the dashboard is shown
      // In a real app, this would fetch the latest data
    },
  };
}
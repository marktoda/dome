import blessed from 'blessed';
import contrib from 'blessed-contrib';
import figlet from 'figlet';
import chalk from 'chalk';

/**
 * Interface for the base layout elements
 */
export interface BaseLayoutElements {
  screen: blessed.Widgets.Screen;
  grid: any; // blessed-contrib grid
  header: blessed.Widgets.BoxElement;
  sidebar: blessed.Widgets.ListElement;
  mainContent: blessed.Widgets.BoxElement;
  statusBar: blessed.Widgets.BoxElement;
}

/**
 * Create the base layout for the TUI
 * @returns The base layout elements
 */
export function createBaseLayout(): BaseLayoutElements {
  // Create a screen object
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Dome CLI',
    dockBorders: true,
    fullUnicode: true,
  });

  // Set key bindings for global navigation
  screen.key(['escape', 'q', 'C-c'], () => {
    return process.exit(0);
  });

  // Create a grid layout
  const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });

  // Create header
  const header = grid.set(0, 0, 1, 12, blessed.box, {
    content: chalk.cyan(figlet.textSync('dome', { font: 'Standard' })),
    tags: true,
    style: {
      fg: 'cyan',
      border: {
        fg: 'cyan',
      },
    },
  });

  // Create sidebar for navigation
  const sidebar = grid.set(1, 0, 10, 3, blessed.list, {
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: {
        bg: 'cyan',
        fg: 'black',
      },
      border: {
        fg: 'cyan',
      },
    },
    border: {
      type: 'line',
    },
    items: [
      'Dashboard',
      'Chat',
      'Notes',
      'Tasks',
      'Search',
      'Settings',
      'Help',
    ],
  });

  // Create main content area
  const mainContent = grid.set(1, 3, 10, 9, blessed.box, {
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'cyan',
      },
    },
  });

  // Create status bar
  const statusBar = grid.set(11, 0, 1, 12, blessed.box, {
    content: ' {bold}Status:{/bold} Ready | Press {bold}q{/bold} to quit | {bold}?{/bold} for help',
    tags: true,
    style: {
      fg: 'white',
      bg: 'blue',
    },
  });

  return {
    screen,
    grid,
    header,
    sidebar,
    mainContent,
    statusBar,
  };
}
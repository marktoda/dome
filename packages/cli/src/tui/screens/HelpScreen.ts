import blessed from 'blessed';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';

/**
 * Create the help screen
 * @param layout The base layout elements
 * @returns The help screen
 */
export function createHelpScreen(layout: BaseLayoutElements): Screen {
  // Create the main container
  const element = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Set the help content
  element.setContent(`
{bold}{cyan-fg}Dome CLI Help{/cyan-fg}{/bold}

{bold}About Dome{/bold}
Dome is an AI-powered personal memory assistant that helps you store, organize, and retrieve information.

{bold}Navigation{/bold}
- Use {bold}arrow keys{/bold} to navigate the sidebar
- Press {bold}Enter{/bold} to select an option
- Press {bold}Escape{/bold}, {bold}q{/bold}, or {bold}Ctrl+C{/bold} to quit
- Press {bold}?{/bold} to show this help screen
- Press {bold}h{/bold} to return to the dashboard

{bold}Global Shortcuts{/bold}
- {bold}?{/bold} - Show this help
- {bold}q{/bold} - Quit the application
- {bold}h{/bold} - Return to dashboard
- {bold}c{/bold} - Quick access to chat
- {bold}n{/bold} - Quick access to notes
- {bold}t{/bold} - Quick access to tasks
- {bold}s{/bold} - Quick access to search

{bold}Dashboard{/bold}
The dashboard shows an overview of your data and provides quick access to common actions.

{bold}Chat{/bold}
- Type your message and press {bold}Enter{/bold} to send
- Press {bold}Escape{/bold} to return to the sidebar
- Chat history is preserved during your session

{bold}Notes{/bold}
- View a list of your notes
- Press {bold}a{/bold} to add a new note
- Press {bold}d{/bold} to delete the selected note
- Press {bold}e{/bold} to edit the selected note
- Press {bold}r{/bold} to refresh the list
- Press {bold}Escape{/bold} to return to the sidebar

{bold}Tasks{/bold}
- View a list of your tasks
- Press {bold}a{/bold} to add a new task
- Press {bold}d{/bold} to delete the selected task
- Press {bold}e{/bold} to edit the selected task
- Press {bold}c{/bold} to mark a task as completed
- Press {bold}r{/bold} to refresh the list
- Press {bold}Escape{/bold} to return to the sidebar

{bold}Search{/bold}
- Type your search query and press {bold}Enter{/bold}
- Use arrow keys to navigate search results
- Press {bold}Enter{/bold} to view a search result
- Press {bold}Escape{/bold} to return to the sidebar

{bold}Settings{/bold}
- Configure your Dome CLI settings
- Press {bold}Escape{/bold} to return to the sidebar

{bold}Support{/bold}
For more help or to report issues, visit:
https://github.com/yourusername/dome-cli
  `);

  return {
    id: 'help',
    title: 'Help',
    element,
    onFocus: () => {
      // Set focus to the element when the help screen is shown
      element.focus();
    },
  };
}
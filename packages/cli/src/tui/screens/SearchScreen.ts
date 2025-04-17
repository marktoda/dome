import blessed from 'blessed';
import { BaseLayoutElements } from '../layouts/BaseLayout';
import { Screen } from '../ScreenManager';
import { search } from '../../utils/api';

/**
 * Create the search screen
 * @param layout The base layout elements
 * @returns The search screen
 */
export function createSearchScreen(layout: BaseLayoutElements): Screen {
  // Create the main container
  const element = blessed.box({
    parent: layout.mainContent,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
  });

  // Create a header
  const headerBox = blessed.box({
    parent: element,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{center}{bold}Search{/bold}{/center}',
    tags: true,
  });

  // Create a search input
  const searchInput = blessed.textbox({
    parent: element,
    top: 3,
    left: 0,
    width: '100%',
    height: 3,
    inputOnFocus: true,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
  });

  // Create a loading indicator
  const loadingIndicator = blessed.loading({
    parent: element,
    top: 'center',
    left: 'center',
    width: 20,
    height: 3,
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'cyan',
      },
    },
  });

  // Create a results list
  const resultsList = blessed.list({
    parent: element,
    top: 6,
    left: 0,
    width: '30%',
    height: '100%-9',
    keys: true,
    vi: true,
    mouse: true,
    border: {
      type: 'line',
    },
    style: {
      selected: {
        bg: 'blue',
        fg: 'white',
      },
      border: {
        fg: 'blue',
      },
    },
    scrollable: true,
    alwaysScroll: true,
    items: ['Enter a search query above'],
  });

  // Create a result content box
  const resultContentBox = blessed.box({
    parent: element,
    top: 6,
    right: 0,
    width: '70%',
    height: '100%-9',
    border: {
      type: 'line',
    },
    style: {
      border: {
        fg: 'blue',
      },
    },
    scrollable: true,
    alwaysScroll: true,
    content: 'Select a result to view its content',
    padding: {
      left: 1,
      right: 1,
    },
  });

  // Create a footer with commands
  const footerBox = blessed.box({
    parent: element,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: '{bold}Commands:{/bold} [Enter] Search | [↑/↓] Navigate Results | [Esc] Back to Menu',
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

  // Handle search input
  searchInput.key('enter', async () => {
    const query = searchInput.getValue();
    if (query.trim()) {
      try {
        // Show loading indicator
        loadingIndicator.load('Searching...');
        resultsList.setItems(['Searching...']);
        layout.screen.render();
        
        // Perform search
        const results = await search(query);
        
        // Hide loading indicator
        loadingIndicator.stop();
        
        if (results.length === 0) {
          resultsList.setItems(['No results found']);
          resultContentBox.setContent('No results found for query: ' + query);
        } else {
          // Update results list
          resultsList.setItems(
            results.map((result: any) => result.title || `Result ${result.id.substring(0, 8)}`)
          );
          
          // Store the full results data
          (resultsList as any).resultsData = results;
          
          // Focus the results list
          resultsList.focus();
        }
        
        layout.screen.render();
      } catch (err) {
        // Hide loading indicator
        loadingIndicator.stop();
        
        resultsList.setItems(['Error performing search']);
        resultContentBox.setContent(`Error: ${err instanceof Error ? err.message : String(err)}`);
        layout.screen.render();
      }
    }
  });

  // Handle result selection
  resultsList.on('select', (item: any, index: number) => {
    const results = (resultsList as any).resultsData;
    if (results && results[index]) {
      const result = results[index];
      resultContentBox.setContent(
        `{bold}Title:{/bold} ${result.title || '(No title)'}\n` +
        `{bold}Type:{/bold} ${result.type || 'Unknown'}\n` +
        `{bold}Created:{/bold} ${new Date(result.createdAt).toLocaleString()}\n` +
        `{bold}Tags:{/bold} ${result.tags?.join(', ') || 'None'}\n\n` +
        `${result.content || result.description || 'No content available'}`
      );
      layout.screen.render();
    }
  });

  // Handle escape key to return to sidebar
  element.key('escape', () => {
    layout.sidebar.focus();
  });

  return {
    id: 'search',
    title: 'Search',
    element,
    onFocus: () => {
      // Focus the search input when the search screen is shown
      searchInput.focus();
    },
  };
}
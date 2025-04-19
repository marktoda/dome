import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';
import { search } from '../../utils/api';
import { formatDate } from '../../utils/ui';

/**
 * Search mode for advanced search capabilities
 */
export class SearchMode extends BaseMode {
  private searchBox: blessed.Widgets.TextboxElement | null = null;
  private resultsBox: blessed.Widgets.BoxElement | null = null;
  private statusBar: blessed.Widgets.TextElement | null = null;
  private filterBox: blessed.Widgets.TextboxElement | null = null;
  private isSearching: boolean = false;
  private lastQuery: string = '';
  private results: any[] = [];
  private filters: {
    type?: string;
    dateFrom?: string;
    dateTo?: string;
    tags?: string[];
    sortBy?: 'relevance' | 'date' | 'title';
    sortOrder?: 'asc' | 'desc';
  } = {
    sortBy: 'relevance',
    sortOrder: 'desc',
  };

  /**
   * Create a new search mode
   * @param screen The blessed screen
   */
  constructor(screen: blessed.Widgets.Screen) {
    const config: ModeConfig = {
      name: 'Search',
      description: 'Advanced search with filters and sorting',
      icon: '🔍',
      color: 'yellow',
      keybindings: {
        'Ctrl+f': 'Toggle filter panel',
        'Ctrl+s': 'Change sort order',
        'Ctrl+r': 'Reset filters',
        'Ctrl+n': 'Next result',
        'Ctrl+p': 'Previous result',
      },
      commands: ['filter', 'sort', 'reset', 'type', 'date', 'tags'],
    };
    
    super(config, screen);
  }

  /**
   * Handle mode activation
   */
  protected onActivate(): void {
    // Nothing special needed on activation
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Nothing special needed on deactivation
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    if (this.isSearching) {
      this.updateStatus('Still processing previous search, please wait...');
      return;
    }

    // Store the query
    this.lastQuery = input;

    // Perform the search
    await this.performSearch(input);
  }

  /**
   * Handle a command in this mode
   * @param command The command to handle
   * @param args The command arguments
   */
  async handleCommand(command: string, args: string[]): Promise<boolean> {
    switch (command) {
      case 'filter':
        this.toggleFilterPanel();
        return true;

      case 'sort':
        if (args.length > 0) {
          const sortBy = args[0] as 'relevance' | 'date' | 'title';
          const sortOrder = args[1] as 'asc' | 'desc' || 'desc';
          this.filters.sortBy = sortBy;
          this.filters.sortOrder = sortOrder;
          this.updateStatus(`Sorting by ${sortBy} (${sortOrder})`);
          
          // Re-sort results if we have any
          if (this.results.length > 0 && this.lastQuery) {
            await this.performSearch(this.lastQuery);
          }
        } else {
          // Toggle sort order
          this.filters.sortOrder = this.filters.sortOrder === 'asc' ? 'desc' : 'asc';
          this.updateStatus(`Sort order: ${this.filters.sortOrder}`);
          
          // Re-sort results if we have any
          if (this.results.length > 0 && this.lastQuery) {
            await this.performSearch(this.lastQuery);
          }
        }
        return true;

      case 'reset':
        this.resetFilters();
        this.updateStatus('Filters reset');
        
        // Re-search with reset filters if we have a query
        if (this.lastQuery) {
          await this.performSearch(this.lastQuery);
        }
        return true;

      case 'type':
        if (args.length > 0) {
          this.filters.type = args[0];
          this.updateStatus(`Type filter: ${args[0]}`);
          
          // Re-search with new filter if we have a query
          if (this.lastQuery) {
            await this.performSearch(this.lastQuery);
          }
        }
        return true;

      case 'date':
        if (args.length > 0) {
          if (args[0] === 'from' && args[1]) {
            this.filters.dateFrom = args[1];
            this.updateStatus(`Date from: ${args[1]}`);
          } else if (args[0] === 'to' && args[1]) {
            this.filters.dateTo = args[1];
            this.updateStatus(`Date to: ${args[1]}`);
          }
          
          // Re-search with new filter if we have a query
          if (this.lastQuery) {
            await this.performSearch(this.lastQuery);
          }
        }
        return true;

      case 'tags':
        if (args.length > 0) {
          this.filters.tags = args;
          this.updateStatus(`Tags filter: ${args.join(', ')}`);
          
          // Re-search with new filter if we have a query
          if (this.lastQuery) {
            await this.performSearch(this.lastQuery);
          }
        }
        return true;

      default:
        return false;
    }
  }

  /**
   * Render mode-specific UI elements
   * @param container The container to render in
   */
  render(container: blessed.Widgets.BoxElement): void {
    // Create a search box
    this.searchBox = blessed.textbox({
      parent: container,
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'yellow',
        },
        focus: {
          border: {
            fg: 'bright-yellow',
          },
        },
      },
      inputOnFocus: true,
      keys: true,
      label: ' Search ',
    });

    // Create a results box
    this.resultsBox = blessed.box({
      parent: container,
      top: 3,
      left: 0,
      width: '100%',
      height: '100%-4',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'yellow',
        },
      },
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      label: ' Results ',
      scrollbar: {
        ch: '│',
        style: {
          fg: 'yellow',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    // Create a status bar
    this.statusBar = blessed.text({
      parent: container,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: 'Search Mode | Enter a query to search',
      tags: true,
      style: {
        fg: 'yellow',
      },
    });

    // Create a filter box (hidden by default)
    this.filterBox = blessed.textbox({
      parent: container,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '50%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'yellow',
        },
        focus: {
          border: {
            fg: 'bright-yellow',
          },
        },
      },
      hidden: true,
      label: ' Filters ',
      inputOnFocus: true,
      keys: true,
      tags: true,
    });

    // Set up key bindings
    this.searchBox.key('enter', async () => {
      const query = this.searchBox?.getValue().trim();
      if (query) {
        this.lastQuery = query;
        await this.performSearch(query);
      }
    });

    this.searchBox.key('C-f', () => {
      this.toggleFilterPanel();
    });

    this.searchBox.key('C-s', async () => {
      // Toggle sort order
      this.filters.sortOrder = this.filters.sortOrder === 'asc' ? 'desc' : 'asc';
      this.updateStatus(`Sort order: ${this.filters.sortOrder}`);
      
      // Re-sort results if we have any
      if (this.results.length > 0 && this.lastQuery) {
        await this.performSearch(this.lastQuery);
      }
    });

    this.searchBox.key('C-r', async () => {
      this.resetFilters();
      this.updateStatus('Filters reset');
      
      // Re-search with reset filters if we have a query
      if (this.lastQuery) {
        await this.performSearch(this.lastQuery);
      }
    });

    // Focus the search box
    this.searchBox.focus();
  }

  /**
   * Perform a search
   * @param query The search query
   */
  private async performSearch(query: string): Promise<void> {
    if (this.isSearching) {
      return;
    }

    this.isSearching = true;
    this.updateStatus(`Searching for: ${query}...`);

    try {
      // Build search parameters
      const params: any = { q: query };
      
      // Add filters
      if (this.filters.type) {
        params.type = this.filters.type;
      }
      
      if (this.filters.dateFrom) {
        params.dateFrom = this.filters.dateFrom;
      }
      
      if (this.filters.dateTo) {
        params.dateTo = this.filters.dateTo;
      }
      
      if (this.filters.tags && this.filters.tags.length > 0) {
        params.tags = this.filters.tags.join(',');
      }
      
      if (this.filters.sortBy) {
        params.sortBy = this.filters.sortBy;
      }
      
      if (this.filters.sortOrder) {
        params.sortOrder = this.filters.sortOrder;
      }

      // Perform the search
      const response = await search(query);
      this.results = response.results || [];

      // Display results
      this.displayResults();

      // Update status
      this.updateStatus(`Found ${this.results.length} results for: ${query}`);
    } catch (err) {
      this.updateStatus(`Error searching: ${err instanceof Error ? err.message : String(err)}`);
      
      if (this.resultsBox) {
        this.resultsBox.setContent('{red-fg}Error performing search. Please try again.{/red-fg}');
        this.screen.render();
      }
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * Display search results
   */
  private displayResults(): void {
    if (!this.resultsBox) {
      return;
    }

    if (this.results.length === 0) {
      this.resultsBox.setContent('{yellow-fg}No results found.{/yellow-fg}');
      this.screen.render();
      return;
    }

    let content = '';

    this.results.forEach((result, index) => {
      const title = result.title || 'Untitled';
      const type = result.type || 'item';
      const score = result.score?.toFixed(2) || 'N/A';
      const date = formatDate(result.createdAt || result.created_at || new Date());
      const excerpt = result.excerpt || result.content || '';
      const truncatedExcerpt = excerpt.length > 100 ? excerpt.substring(0, 100) + '...' : excerpt;
      const tags = result.tags && result.tags.length > 0 ? result.tags.join(', ') : '';
      const typeColor = type === 'note' ? 'cyan' : type === 'task' ? 'yellow' : 'white';

      content += `{bold}${index + 1}. ${title}{/bold} {gray-fg}(Score: ${score}){/gray-fg}\n`;
      content += `{${typeColor}-fg}Type: ${type}{/${typeColor}-fg} | Created: ${date}\n`;
      if (tags) {
        content += `Tags: ${tags}\n`;
      }
      content += `\n${truncatedExcerpt}\n`;
      content += '{gray-fg}' + '-'.repeat(50) + '{/gray-fg}\n\n';
    });

    this.resultsBox.setContent(content);
    this.resultsBox.scrollTo(0);
    this.screen.render();
  }

  /**
   * Update the status bar
   * @param message The status message
   */
  private updateStatus(message: string): void {
    if (!this.statusBar) {
      return;
    }

    // Build filter info
    let filterInfo = '';
    if (this.filters.type) {
      filterInfo += ` | Type: ${this.filters.type}`;
    }
    if (this.filters.tags && this.filters.tags.length > 0) {
      filterInfo += ` | Tags: ${this.filters.tags.join(',')}`;
    }
    if (this.filters.dateFrom || this.filters.dateTo) {
      filterInfo += ' | Date:';
      if (this.filters.dateFrom) {
        filterInfo += ` From ${this.filters.dateFrom}`;
      }
      if (this.filters.dateTo) {
        filterInfo += ` To ${this.filters.dateTo}`;
      }
    }
    filterInfo += ` | Sort: ${this.filters.sortBy} (${this.filters.sortOrder})`;

    this.statusBar.setContent(`Search Mode | ${message}${filterInfo}`);
    this.screen.render();
  }

  /**
   * Toggle the filter panel
   */
  private toggleFilterPanel(): void {
    if (!this.filterBox) {
      return;
    }

    if (this.filterBox.hidden) {
      // Show the filter panel
      this.filterBox.hidden = false;
      
      // Set the filter content
      let content = 'Enter filter commands:\n\n';
      content += '/type <type> - Filter by type (note, task, etc.)\n';
      content += '/date from <YYYY-MM-DD> - Filter from date\n';
      content += '/date to <YYYY-MM-DD> - Filter to date\n';
      content += '/tags <tag1> <tag2> ... - Filter by tags\n';
      content += '/sort <field> <order> - Sort by field (relevance, date, title)\n';
      content += '/reset - Reset all filters\n\n';
      content += 'Current filters:\n';
      content += `Type: ${this.filters.type || 'Any'}\n`;
      content += `Date: ${this.filters.dateFrom || 'Any'} to ${this.filters.dateTo || 'Any'}\n`;
      content += `Tags: ${this.filters.tags?.join(', ') || 'Any'}\n`;
      content += `Sort: ${this.filters.sortBy} (${this.filters.sortOrder})\n\n`;
      content += 'Press Escape to close';
      
      this.filterBox.setValue(content);
      this.filterBox.focus();
    } else {
      // Hide the filter panel
      this.filterBox.hidden = true;
      this.searchBox?.focus();
    }

    this.screen.render();
  }

  /**
   * Reset all filters
   */
  private resetFilters(): void {
    this.filters = {
      sortBy: 'relevance',
      sortOrder: 'desc',
    };
  }

  /**
   * Get help text for this mode
   * @returns The help text
   */
  getHelpText(): string {
    return `
{bold}Search Mode Help{/bold}

Search mode provides advanced search capabilities with filters and sorting.

{bold}Commands:{/bold}
  {cyan-fg}/filter{/cyan-fg} - Toggle filter panel
  {cyan-fg}/sort <field> <order>{/cyan-fg} - Sort by field (relevance, date, title)
  {cyan-fg}/reset{/cyan-fg} - Reset all filters
  {cyan-fg}/type <type>{/cyan-fg} - Filter by type (note, task, etc.)
  {cyan-fg}/date from <YYYY-MM-DD>{/cyan-fg} - Filter from date
  {cyan-fg}/date to <YYYY-MM-DD>{/cyan-fg} - Filter to date
  {cyan-fg}/tags <tag1> <tag2> ...{/cyan-fg} - Filter by tags

{bold}Keybindings:{/bold}
  {cyan-fg}Ctrl+f{/cyan-fg} - Toggle filter panel
  {cyan-fg}Ctrl+s{/cyan-fg} - Change sort order
  {cyan-fg}Ctrl+r{/cyan-fg} - Reset filters
  {cyan-fg}Ctrl+n{/cyan-fg} - Next result
  {cyan-fg}Ctrl+p{/cyan-fg} - Previous result
`;
  }
}
import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk';

/**
 * Explore mode for browsing and searching content
 */
export class ExploreMode extends BaseMode {
  private notes: any[] = [];
  private currentPage: number = 0;
  private pageSize: number = 10;
  private totalPages: number = 0;
  private searchResults: any = null;

  /**
   * Create a new explore mode
   */
  constructor() {
    super({
      id: 'explore',
      name: 'Explore',
      description: 'Browse and search your content',
      shortcut: 'C-e', // Changed back to C-e for Explore
      color: 'blue',
    });
  }

  /**
   * Handle mode initialization
   */
  protected onInit(): void {
    // Nothing to initialize
  }

  /**
   * Handle mode activation
   */
  protected onActivate(): void {
    this.container.setLabel(' Explore Content ');
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Explore Mode{/bold}{/center}');
    this.container.pushLine('{center}Loading your content...{/center}');
    this.container.pushLine('');
    this.screen.render();

    // Load notes when activated
    this.loadNotes();
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Reset state
    this.searchResults = null;
  }

  /**
   * Load notes from the API
   */
  private async loadNotes(): Promise<void> {
    try {
      this.statusBar.setContent(' {bold}Status:{/bold} Loading notes...');
      this.screen.render();

      const apiClient = getApiClient();
      // Fetch with a limit for pagination; TUI will handle pages
      const notesResponse: DomeApi.Note[] = await apiClient.notes.listNotes({
        limit: 1000, // Fetch a large number, TUI will paginate locally for now
        offset: 0,
        // category: undefined // Potentially add category filter later
      });
      this.notes = notesResponse || [];
      
      // Calculate total pages based on fetched notes and pageSize
      this.totalPages = Math.ceil(this.notes.length / this.pageSize);
      this.currentPage = 0; // Reset to first page

      this.displayNotes();

      // Reset status
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    } catch (err: unknown) {
      this.container.setContent('');
      this.container.pushLine('{center}{bold}Explore Mode{/bold}{/center}');
      let errorMessage = 'Error loading notes.';
      if (err instanceof DomeApiError) {
        const apiError = err as DomeApiError;
        errorMessage = `API Error loading notes: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
      } else if (err instanceof DomeApiTimeoutError) {
        const timeoutError = err as DomeApiTimeoutError;
        errorMessage = `API Timeout loading notes: ${timeoutError.message}`;
      } else if (err instanceof Error) {
        errorMessage = `Error loading notes: ${err.message}`;
      }
      this.container.pushLine(`{red-fg}${errorMessage}{/red-fg}`);
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    }
  }

  /**
   * Display notes in the container
   */
  private displayNotes(): void {
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Your Notes{/bold}{/center}');
    this.container.pushLine('');

    if (this.notes.length === 0) {
      this.container.pushLine('{center}No notes found. Create a note with /add{/center}');
      this.screen.render();
      return;
    }

    // Get current page of notes
    const start = this.currentPage * this.pageSize;
    const end = Math.min(start + this.pageSize, this.notes.length);
    const pageNotes = this.notes.slice(start, end);

    // Display notes
    pageNotes.forEach((note, index) => {
      const noteItem = note as DomeApi.Note; // Cast to SDK type
      const title = noteItem.title || 'Untitled';
      const content = noteItem.content || '';
      const date = new Date(noteItem.createdAt).toLocaleString();
      const category = noteItem.category || '(No category)';

      this.container.pushLine(`{bold}${start + index + 1}. ${title}{/bold}`);
      this.container.pushLine(
        `{gray-fg}ID: ${noteItem.id} | Category: ${category} | Created: ${date}{/gray-fg}`,
      );
      // Tags are not directly available in DomeApi.Note
      this.container.pushLine(`${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      this.container.pushLine('');
    });

    // Display pagination info
    this.container.pushLine('');
    this.container.pushLine(
      `{center}Page ${this.currentPage + 1} of ${this.totalPages || 1}{/center}`,
    );
    this.container.pushLine(
      '{center}Type {bold}next{/bold} or {bold}prev{/bold} to navigate pages{/center}',
    );

    this.screen.render();
  }

  /**
   * Display search results
   * @param results The search results
   */
  private displaySearchResults(results: any): void {
    this.container.setContent('');
    this.container.pushLine(`{center}{bold}Search Results for "${results.query}"{/bold}{/center}`);
    this.container.pushLine('');

    if (!results.results || results.results.length === 0) {
      this.container.pushLine('{center}No results found{/center}');
      this.screen.render();
      return;
    }

    // Display results
    results.results.forEach((matchItem: DomeApi.SearchResultItem, index: number) => {
      const match = matchItem as DomeApi.SearchResultItem; // Cast to SDK type
      this.container.pushLine(
        `{bold}${index + 1}. ${match.title || 'Untitled'}{/bold} (Score: ${
          match.score?.toFixed(2) || 'N/A'
        })`,
      );
      this.container.pushLine(
         `{gray-fg}ID: ${match.id} | Category: ${match.category} | MIME: ${match.mimeType}{/gray-fg}`
      );
      if (match.createdAt) {
        this.container.pushLine(
          `{gray-fg}Created: ${new Date(match.createdAt).toLocaleString()}{/gray-fg}`,
        );
      }
      // Tags are not directly available in DomeApi.SearchResultItem

      if (match.summary) {
          this.container.pushLine(`{bold}Summary:{/bold} ${match.summary}`);
      }
      
      if (match.body) {
        const excerpt = match.body.length > 200 ? match.body.substring(0, 200) + '...' : match.body;
        this.container.pushLine('{bold}Body Snippet:{/bold}');
        this.container.pushLine(excerpt);
      }

      this.container.pushLine('');
    });

    // Display pagination info
    this.container.pushLine('');
    const totalResults = results.pagination?.total || results.results.length;
    this.container.pushLine(`{center}Found ${totalResults} results{/center}`);
    this.container.pushLine('{center}Type {bold}back{/bold} to return to notes{/center}');

    this.screen.render();
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    const lowerInput = input.toLowerCase();

    // Handle navigation commands
    if (this.searchResults) {
      // In search results view
      if (lowerInput === 'back') {
        this.searchResults = null;
        this.displayNotes();
        return;
      }
    } else {
      // In notes view
      if (lowerInput === 'next' && this.currentPage < this.totalPages - 1) {
        this.currentPage++;
        this.displayNotes();
        return;
      } else if (lowerInput === 'prev' && this.currentPage > 0) {
        this.currentPage--;
        this.displayNotes();
        return;
      } else if (lowerInput === 'refresh') {
        await this.loadNotes();
        return;
      }
    }

    // Handle search
    if (input.length > 0 && !['next', 'prev', 'back', 'refresh'].includes(lowerInput)) {
      try {
        this.statusBar.setContent(' {bold}Status:{/bold} Searching...');
        this.screen.render();

        const apiClient = getApiClient();
        const searchRequest: DomeApi.GetSearchRequest = { q: input, limit: 10 }; // Default limit for TUI
        const sdkResults: DomeApi.SearchResponse = await apiClient.search.searchContent(searchRequest);
        
        // Adapt sdkResults to the structure displaySearchResults expects or update displaySearchResults
        // For now, assuming displaySearchResults can handle sdkResults.results and sdkResults.pagination
        this.searchResults = sdkResults; // Store the whole SDK response
        this.displaySearchResults(sdkResults);

        this.statusBar.setContent(
          ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
        );
        this.screen.render();
      } catch (err: unknown) {
        let errorMessage = 'Error searching.';
        if (err instanceof DomeApiError) {
          const apiError = err as DomeApiError;
          errorMessage = `API Error searching: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
        } else if (err instanceof DomeApiTimeoutError) {
          const timeoutError = err as DomeApiTimeoutError;
          errorMessage = `API Timeout searching: ${timeoutError.message}`;
        } else if (err instanceof Error) {
          errorMessage = `Error searching: ${err.message}`;
        }
        this.container.pushLine(`{red-fg}${errorMessage}{/red-fg}`);
        this.statusBar.setContent(
          ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
        );
        this.screen.render();
      }
    }
  }

  /**
   * Get help text for this mode
   */
  getHelpText(): string {
    return `
{bold}Explore Mode Help{/bold}

In Explore Mode, you can browse and search your content.

{bold}Usage:{/bold}
- Type a search query and press Enter to search
- Type {bold}next{/bold} or {bold}prev{/bold} to navigate pages of notes
- Type {bold}back{/bold} to return from search results to notes
- Type {bold}refresh{/bold} to reload notes

{bold}Shortcuts:{/bold}
- {cyan-fg}${this.config.shortcut}{/cyan-fg} - Switch to Explore Mode
`;
  }
}

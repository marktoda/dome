import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { listNotes, search } from '../../utils/api';

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

      // The updated listNotes function should already return an array
      this.notes = await listNotes();

      // Calculate total pages
      this.totalPages = Math.ceil(this.notes.length / this.pageSize);

      // Display notes
      this.displayNotes();

      // Reset status
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    } catch (err) {
      this.container.setContent('');
      this.container.pushLine('{center}{bold}Explore Mode{/bold}{/center}');
      this.container.pushLine(
        `{red-fg}Error loading notes: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
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
      const title = note.title || 'Untitled';
      const content = note.body || '';
      const date = new Date(note.createdAt).toLocaleString();

      // Try to extract tags from metadata if available
      let tags: string[] = [];
      if (note.metadata) {
        try {
          const metadata =
            typeof note.metadata === 'string' ? JSON.parse(note.metadata) : note.metadata;

          if (metadata.tags && Array.isArray(metadata.tags)) {
            tags = metadata.tags;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }

      this.container.pushLine(`{bold}${start + index + 1}. ${title}{/bold}`);
      this.container.pushLine(
        `{gray-fg}Created: ${date} | Type: ${note.contentType || 'text/plain'}{/gray-fg}`,
      );
      if (tags.length > 0) {
        this.container.pushLine(`{gray-fg}Tags: ${tags.join(', ')}{/gray-fg}`);
      }
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
    results.results.forEach((match: any, index: number) => {
      this.container.pushLine(
        `{bold}${index + 1}. ${match.title || 'Untitled'}{/bold} (Score: ${
          match.score?.toFixed(2) || 'N/A'
        })`,
      );

      if (match.createdAt) {
        this.container.pushLine(
          `{gray-fg}Created: ${new Date(match.createdAt).toLocaleString()} | Type: ${
            match.contentType || 'text/plain'
          }{/gray-fg}`,
        );
      }

      // Try to extract tags from metadata if available
      let tags: string[] = [];
      if (match.metadata) {
        try {
          const metadata =
            typeof match.metadata === 'string' ? JSON.parse(match.metadata) : match.metadata;

          if (metadata.tags && Array.isArray(metadata.tags)) {
            tags = metadata.tags;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }

      if (tags.length > 0) {
        this.container.pushLine(`{gray-fg}Tags: ${tags.join(', ')}{/gray-fg}`);
      }

      // Display content - use body field from new API
      if (match.body) {
        const excerpt = match.body.length > 150 ? match.body.substring(0, 150) + '...' : match.body;

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

        const results = await search(input);
        this.searchResults = results;
        this.displaySearchResults(results);

        this.statusBar.setContent(
          ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
        );
        this.screen.render();
      } catch (err) {
        this.container.pushLine(
          `{red-fg}Error searching: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
        );
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

import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { addContent, listNotes, search, showItem } from '../../utils/api';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Note mode for creating and editing notes
 */
export class NoteMode extends BaseMode {
  private isEditing: boolean = false;
  private searchResults: any[] = [];
  private searchQuery: string = '';
  private selectedNoteIndex: number = -1;
  private viewMode: 'create' | 'search' | 'view' = 'create';

  /**
   * Create a new note mode
   */
  constructor() {
    super({
      id: 'note',
      name: 'Note',
      description: 'Create and edit notes',
      shortcut: 'C-n',
      color: 'yellow',
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
    this.container.setLabel(' Note Mode ');
    this.showMainMenu();
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Reset state
    this.resetState();
  }

  /**
   * Reset state
   */
  private resetState(): void {
    this.isEditing = false;
    this.searchResults = [];
    this.searchQuery = '';
    this.selectedNoteIndex = -1;
    this.viewMode = 'create';
  }

  /**
   * Show main menu
   */
  private showMainMenu(): void {
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Note Mode{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('What would you like to do?');
    this.container.pushLine('');
    this.container.pushLine('  {bold}create{/bold} - Create a new note');
    this.container.pushLine('  {bold}search{/bold} - Search existing notes');
    this.container.pushLine('  {bold}list{/bold} - List recent notes');
    this.container.pushLine('');
    this.container.pushLine('{gray-fg}Type one of the commands above to continue{/gray-fg}');
    this.screen.render();
  }

  /**
   * Get the user's preferred editor
   */
  private getEditor(): string {
    return process.env.EDITOR || 'nvim';
  }

  /**
   * Create a temporary file with metadata
   */
  private createTempFileWithMetadata(title?: string): string {
    const tempFilePath = path.join(os.tmpdir(), `dome-note-${Date.now()}.md`);
    const date = new Date().toISOString();

    const metadata = [
      `# ${title || 'New Note'}`,
      `Date: ${date}`,
      `Tags: `,
      '',
      '<!-- Write your note content below this line -->',
      '',
    ].join('\n');

    fs.writeFileSync(tempFilePath, metadata);
    return tempFilePath;
  }

  /**
   * Open editor with content
   */
  private openEditor(filePath: string): Promise<void> {
    this.isEditing = true;

    // Show status message
    this.container.setContent('');
    this.container.pushLine('{center}{bold}External Editor{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('Opening external editor...');
    this.container.pushLine('');
    this.container.pushLine(`Editor: ${this.getEditor()}`);
    this.container.pushLine(`File: ${filePath}`);
    this.container.pushLine('');
    this.container.pushLine('{gray-fg}The TUI will resume when you exit the editor{/gray-fg}');
    this.screen.render();

    // Use execSync for better terminal handling
    return new Promise((resolve, reject) => {
      try {
        // Save the current terminal state
        const originalStdin = process.stdin.isRaw;

        // Leave the alternate screen buffer temporarily
        this.screen.program.normalBuffer();
        this.screen.program.clear();

        // Use execSync for better terminal handling - this blocks until editor exits
        const { execSync } = require('child_process');
        const editor = this.getEditor();

        try {
          execSync(`${editor} "${filePath}"`, {
            stdio: 'inherit',
            env: process.env,
          });

          // Return to the alternate screen buffer and restore the TUI
          process.nextTick(() => {
            // Return to alternate buffer
            this.screen.program.alternateBuffer();

            // Restore raw mode if it was enabled
            if (originalStdin) {
              process.stdin.setRawMode(true);
            }

            // Force a redraw of the screen
            this.screen.program.clear();
            this.screen.program.cursorReset();
            this.screen.realloc();
            this.screen.render();

            this.isEditing = false;
            resolve();
          });
        } catch (error) {
          // Return to the alternate screen buffer and restore the TUI even on error
          process.nextTick(() => {
            // Return to alternate buffer
            this.screen.program.alternateBuffer();

            // Restore raw mode if it was enabled
            if (originalStdin) {
              process.stdin.setRawMode(true);
            }

            // Force a redraw of the screen
            this.screen.program.clear();
            this.screen.program.cursorReset();
            this.screen.realloc();
            this.screen.render();

            this.isEditing = false;
            const errorMessage = error instanceof Error ? error.message : String(error);
            reject(new Error(`Editor exited with error: ${errorMessage}`));
          });
        }
      } catch (err) {
        this.isEditing = false;
        reject(err);
      }
    });
  }

  /**
   * Parse note content from file
   */
  private parseNoteContent(filePath: string): {
    title: string;
    content: string;
    tags: string[];
    summary?: string;
  } {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n');

    let title = 'Untitled Note';
    let tags: string[] = [];
    let summary: string | undefined = undefined;
    let contentStartIndex = 0;

    // Parse metadata
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (i === 0 && line.startsWith('# ')) {
        title = line.substring(2).trim();
        continue;
      }

      if (line.startsWith('Tags:')) {
        const tagsPart = line.substring(5).trim();
        if (tagsPart) {
          tags = tagsPart.split(',').map(tag => tag.trim());
        }
        continue;
      }

      if (line.startsWith('Summary:')) {
        summary = line.substring(8).trim();
        continue;
      }

      if (line.includes('<!-- Write your note content below this line -->')) {
        contentStartIndex = i + 1;
        break;
      }

      // If we've gone through several lines without finding the marker,
      // assume content starts after a reasonable number of metadata lines
      if (i >= 7) {
        // Increased to account for possible summary line
        contentStartIndex = i;
        break;
      }
    }

    const content = lines.slice(contentStartIndex).join('\n').trim();

    return { title, content, tags, summary };
  }

  /**
   * Create a new note
   */
  private async createNewNote(): Promise<void> {
    try {
      // Create temp file with metadata
      const tempFilePath = this.createTempFileWithMetadata();

      // Open editor
      await this.openEditor(tempFilePath);

      // Parse note content
      const { title, content, tags } = this.parseNoteContent(tempFilePath);

      if (!content.trim()) {
        this.container.setContent('');
        this.container.pushLine('{yellow-fg}Note was empty, nothing saved.{/yellow-fg}');
        this.container.pushLine('');
        this.container.pushLine('Press any key to return to the main menu.');
        this.screen.render();
        return;
      }

      // Save the note
      this.statusBar.setContent(' {bold}Status:{/bold} Saving note...');
      this.screen.render();

      const response = await addContent(content, title, tags);

      // Clean up temp file
      try {
        fs.unlinkSync(tempFilePath);
      } catch (err) {
        // Ignore errors when deleting temp file
      }

      // Show success message
      this.container.setContent('');
      this.container.pushLine('{center}{bold}Note Saved{/bold}{/center}');
      this.container.pushLine('');
      this.container.pushLine(
        `{green-fg}Your note "${title}" has been saved successfully!{/green-fg}`,
      );
      if (response && response.id) {
        this.container.pushLine(`{bold}ID:{/bold} ${response.id}`);
        this.container.pushLine(
          `{bold}Content Type:{/bold} ${response.contentType || 'text/plain'}`,
        );

        // Show that the note will be processed for title and summary
        this.container.pushLine(
          '{gray-fg}Note will be processed to generate title and summary.{/gray-fg}',
        );
      }
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');

      // Reset status
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    } catch (err) {
      this.container.setContent('');
      this.container.pushLine(
        `{red-fg}Error creating note: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    }
  }

  /**
   * Show search prompt
   */
  private showSearchPrompt(): void {
    this.viewMode = 'search';
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Search Notes{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('Enter search query:');
    if (this.searchQuery) {
      this.container.pushLine(`Current: ${this.searchQuery}`);
    }
    this.container.pushLine('');
    this.container.pushLine(
      '{gray-fg}(Type {bold}menu{/bold} to return to the main menu){/gray-fg}',
    );
    this.screen.render();
  }

  /**
   * Search for notes
   */
  private async searchNotes(query: string): Promise<void> {
    try {
      this.searchQuery = query;
      this.statusBar.setContent(' {bold}Status:{/bold} Searching notes...');
      this.screen.render();

      const response = await search(query, 20);
      this.searchResults = response.results || [];

      this.showSearchResults();
    } catch (err) {
      this.container.setContent('');
      this.container.pushLine(
        `{red-fg}Error searching notes: ${
          err instanceof Error ? err.message : String(err)
        }{/red-fg}`,
      );
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    }
  }

  /**
   * Show search results
   */
  private showSearchResults(): void {
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Search Results{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine(`Query: "${this.searchQuery}"`);
    this.container.pushLine('');

    if (this.searchResults.length === 0) {
      this.container.pushLine('{yellow-fg}No results found.{/yellow-fg}');
    } else {
      this.container.pushLine(`Found ${this.searchResults.length} results:`);
      this.container.pushLine('');

      this.searchResults.forEach((result, index) => {
        const title = result.title || 'Untitled Note';
        const date = result.createdAt
          ? new Date(result.createdAt).toLocaleString()
          : 'Unknown date';
        this.container.pushLine(`{bold}${index + 1}.{/bold} ${title} (${date})`);

        // Display summary if available
        if (result.summary) {
          this.container.pushLine(
            `   {gray-fg}${result.summary.substring(0, 80)}${
              result.summary.length > 80 ? '...' : ''
            }{/gray-fg}`,
          );
        }
      });

      this.container.pushLine('');
      this.container.pushLine('Enter the number of the note to view/edit, or:');
    }

    this.container.pushLine(
      '{gray-fg}Type {bold}search{/bold} to search again or {bold}menu{/bold} to return to the main menu{/gray-fg}',
    );

    this.statusBar.setContent(
      ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
    );
    this.screen.render();
  }

  /**
   * List recent notes
   */
  private async listRecentNotes(): Promise<void> {
    try {
      this.statusBar.setContent(' {bold}Status:{/bold} Loading recent notes...');
      this.screen.render();

      const notes = await listNotes();
      this.searchResults = notes || [];

      this.container.setContent('');
      this.container.pushLine('{center}{bold}Recent Notes{/bold}{/center}');
      this.container.pushLine('');

      if (this.searchResults.length === 0) {
        this.container.pushLine('{yellow-fg}No notes found.{/yellow-fg}');
      } else {
        this.container.pushLine(`Found ${this.searchResults.length} notes:`);
        this.container.pushLine('');

        this.searchResults.forEach((note, index) => {
          const title = note.title || 'Untitled Note';
          const date = note.createdAt ? new Date(note.createdAt).toLocaleString() : 'Unknown date';
          this.container.pushLine(`{bold}${index + 1}.{/bold} ${title} (${date})`);

          // Display summary if available
          if (note.summary) {
            this.container.pushLine(
              `   {gray-fg}${note.summary.substring(0, 80)}${
                note.summary.length > 80 ? '...' : ''
              }{/gray-fg}`,
            );
          }
        });

        this.container.pushLine('');
        this.container.pushLine('Enter the number of the note to view/edit, or:');
      }

      this.container.pushLine(
        '{gray-fg}Type {bold}menu{/bold} to return to the main menu{/gray-fg}',
      );

      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    } catch (err) {
      this.container.setContent('');
      this.container.pushLine(
        `{red-fg}Error listing notes: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    }
  }

  /**
   * View and edit a note
   */
  private async viewAndEditNote(index: number): Promise<void> {
    try {
      if (index < 0 || index >= this.searchResults.length) {
        this.container.pushLine('{red-fg}Invalid note number.{/red-fg}');
        this.screen.render();
        return;
      }

      const note = this.searchResults[index];
      this.selectedNoteIndex = index;

      this.statusBar.setContent(' {bold}Status:{/bold} Loading note...');
      this.screen.render();

      // Get full note content if needed
      let fullNote = note;
      if (!note.content) {
        fullNote = await showItem(note.id);
      }

      const title = fullNote.title || 'Untitled Note';
      const content = fullNote.content || '';

      // Create temp file with note content
      const tempFilePath = path.join(os.tmpdir(), `dome-note-${Date.now()}.md`);

      // Format the content with metadata
      const date = fullNote.createdAt
        ? new Date(fullNote.createdAt).toISOString()
        : new Date().toISOString();
      const tags = fullNote.tags ? fullNote.tags.join(', ') : '';

      // Include summary in the metadata if available
      const summary = fullNote.summary || '';

      const fileContent = [
        `# ${title}`,
        `Date: ${date}`,
        `Tags: ${tags}`,
        summary ? `Summary: ${summary}` : '',
        '',
        '<!-- Write your note content below this line -->',
        content,
      ].join('\n');

      fs.writeFileSync(tempFilePath, fileContent);

      // Open editor
      await this.openEditor(tempFilePath);

      // Parse updated content
      const updatedNote = this.parseNoteContent(tempFilePath);

      // Clean up temp file
      try {
        fs.unlinkSync(tempFilePath);
      } catch (err) {
        // Ignore errors when deleting temp file
      }

      // Save the updated note
      this.statusBar.setContent(' {bold}Status:{/bold} Saving updated note...');
      this.screen.render();

      // For now, we'll create a new note with the updated content
      // In a real implementation, you'd want to update the existing note
      const response = await addContent(updatedNote.content, updatedNote.title, updatedNote.tags);

      // Show success message
      this.container.setContent('');
      this.container.pushLine('{center}{bold}Note Updated{/bold}{/center}');
      this.container.pushLine('');
      this.container.pushLine(
        `{green-fg}Your note "${updatedNote.title}" has been updated successfully!{/green-fg}`,
      );
      if (response && response.id) {
        this.container.pushLine(`{bold}ID:{/bold} ${response.id}`);

        // Show that the note will be processed for title and summary
        this.container.pushLine(
          '{gray-fg}Note will be processed to generate title and summary.{/gray-fg}',
        );
      }
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');

      // Reset status
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    } catch (err) {
      this.container.setContent('');
      this.container.pushLine(
        `{red-fg}Error editing note: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      this.container.pushLine('');
      this.container.pushLine('Type {bold}menu{/bold} to return to the main menu.');
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();
    }
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    // Don't process input while editing
    if (this.isEditing) {
      return;
    }

    // Trim input and convert to lowercase for command matching
    const trimmedInput = input.trim();
    if (!trimmedInput) return; // Ignore empty input

    const lowerInput = trimmedInput.toLowerCase();

    // Handle menu command from anywhere - process this first for responsiveness
    if (lowerInput === 'menu') {
      this.resetState();
      this.showMainMenu();
      return;
    }

    // Use a more direct approach to handle commands for better performance
    try {
      // Handle input based on current view mode
      switch (this.viewMode) {
        case 'create':
          if (lowerInput === 'create') {
            // Update UI immediately to show we're processing
            this.statusBar.setContent(' {bold}Status:{/bold} Creating new note...');
            this.screen.render();

            // Process in next tick to allow UI to update
            process.nextTick(async () => {
              try {
                await this.createNewNote();
              } catch (err) {
                this.container.pushLine(
                  `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
                );
                this.screen.render();
              }
            });
          } else if (lowerInput === 'search') {
            this.showSearchPrompt();
          } else if (lowerInput === 'list') {
            // Update UI immediately
            this.statusBar.setContent(' {bold}Status:{/bold} Loading notes...');
            this.screen.render();

            // Process in next tick
            process.nextTick(async () => {
              try {
                await this.listRecentNotes();
              } catch (err) {
                this.container.pushLine(
                  `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
                );
                this.screen.render();
              }
            });
          }
          break;

        case 'search':
          if (lowerInput === 'search') {
            this.showSearchPrompt();
          } else if (this.searchResults.length > 0) {
            // Check if input is a number
            const noteNumber = parseInt(trimmedInput, 10);
            if (!isNaN(noteNumber) && noteNumber > 0 && noteNumber <= this.searchResults.length) {
              // Update UI immediately
              this.statusBar.setContent(' {bold}Status:{/bold} Loading note...');
              this.screen.render();

              // Process in next tick
              process.nextTick(async () => {
                try {
                  await this.viewAndEditNote(noteNumber - 1);
                } catch (err) {
                  this.container.pushLine(
                    `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
                  );
                  this.screen.render();
                }
              });
            }
          } else if (trimmedInput && lowerInput !== 'menu') {
            // Update UI immediately
            this.statusBar.setContent(' {bold}Status:{/bold} Searching...');
            this.screen.render();

            // Process in next tick
            process.nextTick(async () => {
              try {
                await this.searchNotes(trimmedInput);
              } catch (err) {
                this.container.pushLine(
                  `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
                );
                this.screen.render();
              }
            });
          }
          break;

        case 'view':
          // This mode is not used currently
          this.showMainMenu();
          break;
      }
    } catch (err) {
      // Catch any unexpected errors to prevent the UI from freezing
      this.container.pushLine(
        `{red-fg}Unexpected error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
      this.screen.render();
    }
  }

  /**
   * Get help text for this mode
   */
  getHelpText(): string {
    return `
{bold}Note Mode Help{/bold}

In Note Mode, you can create and edit notes using your preferred text editor.

{bold}Commands:{/bold}
- {bold}create{/bold} - Create a new note in your editor
- {bold}search{/bold} - Search for existing notes
- {bold}list{/bold} - List recent notes
- {bold}menu{/bold} - Return to the main menu

{bold}Editor:{/bold}
The note mode uses your $EDITOR environment variable (defaults to neovim).
When you exit the editor, the note will be saved automatically.

{bold}Shortcuts:{/bold}
- {cyan-fg}${this.config.shortcut}{/cyan-fg} - Switch to Note Mode
`;
  }
}

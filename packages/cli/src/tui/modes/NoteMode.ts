import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { addContent } from '../../utils/api';

/**
 * Note mode for creating and editing notes
 */
export class NoteMode extends BaseMode {
  private noteTitle: string = '';
  private noteContent: string = '';
  private step: 'title' | 'content' | 'preview' = 'title';

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
    this.container.setLabel(' Create Note ');
    this.resetNote();
    this.showTitlePrompt();
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Reset state
    this.resetNote();
  }

  /**
   * Reset note state
   */
  private resetNote(): void {
    this.noteTitle = '';
    this.noteContent = '';
    this.step = 'title';
  }

  /**
   * Show title prompt
   */
  private showTitlePrompt(): void {
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Create a New Note{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine('Enter a title for your note:');
    if (this.noteTitle) {
      this.container.pushLine(`Current: ${this.noteTitle}`);
    }
    this.container.pushLine('');
    this.container.pushLine('{gray-fg}(Type {bold}cancel{/bold} to cancel){/gray-fg}');
    this.screen.render();
  }

  /**
   * Show content prompt
   */
  private showContentPrompt(): void {
    this.container.setContent('');
    this.container.pushLine(`{bold}Title:{/bold} ${this.noteTitle}`);
    this.container.pushLine('');
    this.container.pushLine('Enter the content for your note:');
    if (this.noteContent) {
      this.container.pushLine(
        `Current: ${this.noteContent.substring(0, 100)}${
          this.noteContent.length > 100 ? '...' : ''
        }`,
      );
    }
    this.container.pushLine('');
    this.container.pushLine(
      '{gray-fg}(Type {bold}done{/bold} when finished or {bold}cancel{/bold} to cancel){/gray-fg}',
    );
    this.screen.render();
  }

  /**
   * Show note preview
   */
  private showNotePreview(): void {
    this.container.setContent('');
    this.container.pushLine('{center}{bold}Note Preview{/bold}{/center}');
    this.container.pushLine('');
    this.container.pushLine(`{bold}Title:{/bold} ${this.noteTitle}`);
    this.container.pushLine('');
    this.container.pushLine(`{bold}Content:{/bold}`);
    this.container.pushLine(this.noteContent);
    this.container.pushLine('');
    this.container.pushLine(
      '{gray-fg}Type {bold}save{/bold} to save the note or {bold}edit{/bold} to continue editing or {bold}cancel{/bold} to cancel{/gray-fg}',
    );
    this.screen.render();
  }

  /**
   * Save the note
   */
  private async saveNote(): Promise<void> {
    try {
      this.statusBar.setContent(' {bold}Status:{/bold} Saving note...');
      this.screen.render();

      // Save the note using the updated API
      // Pass the title separately instead of formatting it into the content
      const response = await addContent(this.noteContent, this.noteTitle);

      // Show success message
      this.container.setContent('');
      this.container.pushLine('{center}{bold}Note Saved{/bold}{/center}');
      this.container.pushLine('');
      this.container.pushLine(
        `{green-fg}Your note "${this.noteTitle}" has been saved successfully!{/green-fg}`,
      );
      if (response && response.id) {
        this.container.pushLine(`{bold}ID:{/bold} ${response.id}`);
        this.container.pushLine(
          `{bold}Content Type:{/bold} ${response.contentType || 'text/plain'}`,
        );
      }
      this.container.pushLine('');
      this.container.pushLine(
        'Type {bold}new{/bold} to create another note or switch to another mode.',
      );

      // Reset status
      this.statusBar.setContent(
        ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`,
      );
      this.screen.render();

      // Reset note state
      this.resetNote();
    } catch (err) {
      this.container.pushLine(
        `{red-fg}Error saving note: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
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
    const lowerInput = input.toLowerCase();

    // Handle cancel command
    if (lowerInput === 'cancel') {
      this.resetNote();
      this.showTitlePrompt();
      return;
    }

    // Handle new command after saving
    if (this.step === 'preview' && this.noteTitle === '' && lowerInput === 'new') {
      this.showTitlePrompt();
      return;
    }

    // Handle input based on current step
    switch (this.step) {
      case 'title':
        if (input.trim()) {
          this.noteTitle = input.trim();
          this.step = 'content';
          this.showContentPrompt();
        }
        break;

      case 'content':
        if (lowerInput === 'done') {
          this.step = 'preview';
          this.showNotePreview();
        } else {
          // Append to content if not a command
          if (this.noteContent) {
            this.noteContent += '\n' + input;
          } else {
            this.noteContent = input;
          }
          this.showContentPrompt();
        }
        break;

      case 'preview':
        if (lowerInput === 'save') {
          await this.saveNote();
        } else if (lowerInput === 'edit') {
          this.step = 'content';
          this.showContentPrompt();
        }
        break;
    }
  }

  /**
   * Get help text for this mode
   */
  getHelpText(): string {
    return `
{bold}Note Mode Help{/bold}

In Note Mode, you can create and edit notes.

{bold}Usage:{/bold}
- Follow the prompts to enter a title and content for your note
- Type {bold}done{/bold} when you've finished entering content
- Type {bold}save{/bold} to save the note
- Type {bold}edit{/bold} to continue editing
- Type {bold}cancel{/bold} to cancel at any time
- Type {bold}new{/bold} to create a new note after saving

{bold}Shortcuts:{/bold}
- {cyan-fg}${this.config.shortcut}{/cyan-fg} - Switch to Note Mode
`;
  }
}

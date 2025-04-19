import blessed from 'blessed';
import { BaseMode, ModeConfig } from './BaseMode';
import { addContent } from '../../utils/api';

/**
 * Focus mode for distraction-free writing and thinking
 */
export class FocusMode extends BaseMode {
  private textArea: blessed.Widgets.TextareaElement | null = null;
  private statusText: blessed.Widgets.TextElement | null = null;
  private content: string = '';
  private wordCount: number = 0;
  private charCount: number = 0;
  private isSaving: boolean = false;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private autoSaveEnabled: boolean = false;
  private autoSaveInterval: number = 60000; // 1 minute

  /**
   * Create a new focus mode
   * @param screen The blessed screen
   */
  constructor(screen: blessed.Widgets.Screen) {
    const config: ModeConfig = {
      name: 'Focus',
      description: 'Distraction-free writing environment',
      icon: '✍️',
      color: 'magenta',
      keybindings: {
        'Ctrl+s': 'Save content',
        'Ctrl+a': 'Toggle auto-save',
        'Ctrl+c': 'Clear content',
        'Esc': 'Exit focus mode',
      },
      commands: ['save', 'clear', 'autosave', 'wordcount'],
    };
    
    super(config, screen);
  }

  /**
   * Handle mode activation
   */
  protected onActivate(): void {
    // Start auto-save timer if enabled
    if (this.autoSaveEnabled) {
      this.startAutoSave();
    }
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Stop auto-save timer
    this.stopAutoSave();
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    // In focus mode, we append the input to the content
    this.content += input + '\n';
    
    // Update the text area
    if (this.textArea) {
      this.textArea.setValue(this.content);
    }
    
    // Update word and character counts
    this.updateCounts();
    
    // Update the status text
    this.updateStatusText();
  }

  /**
   * Handle a command in this mode
   * @param command The command to handle
   * @param args The command arguments
   */
  async handleCommand(command: string, args: string[]): Promise<boolean> {
    switch (command) {
      case 'save':
        await this.saveContent();
        return true;

      case 'clear':
        this.clearContent();
        return true;

      case 'autosave':
        if (args.length > 0 && args[0] === 'off') {
          this.autoSaveEnabled = false;
          this.stopAutoSave();
          this.updateStatusText('Auto-save disabled');
        } else if (args.length > 0 && !isNaN(parseInt(args[0]))) {
          // Set auto-save interval in seconds
          this.autoSaveInterval = parseInt(args[0]) * 1000;
          this.autoSaveEnabled = true;
          this.startAutoSave();
          this.updateStatusText(`Auto-save enabled (${args[0]}s)`);
        } else {
          // Toggle auto-save
          this.autoSaveEnabled = !this.autoSaveEnabled;
          if (this.autoSaveEnabled) {
            this.startAutoSave();
            this.updateStatusText('Auto-save enabled');
          } else {
            this.stopAutoSave();
            this.updateStatusText('Auto-save disabled');
          }
        }
        return true;

      case 'wordcount':
        this.updateStatusText(`Words: ${this.wordCount}, Characters: ${this.charCount}`);
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
    // Create a text area for writing
    this.textArea = blessed.textarea({
      parent: container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-2',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'magenta',
        },
        focus: {
          border: {
            fg: 'bright-magenta',
          },
        },
      },
      keys: true,
      inputOnFocus: true,
      alwaysScroll: true,
      scrollable: true,
      scrollbar: {
        ch: '│',
        style: {
          fg: 'magenta',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    // Set the initial content
    this.textArea.setValue(this.content);

    // Create a status text element
    this.statusText = blessed.text({
      parent: container,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      content: 'Focus Mode | Words: 0, Characters: 0',
      tags: true,
      style: {
        fg: 'magenta',
      },
    });

    // Handle text area changes
    this.textArea.on('keypress', () => {
      // Update content on next tick to get the latest value
      process.nextTick(() => {
        if (this.textArea) {
          this.content = this.textArea.getValue();
          this.updateCounts();
          this.updateStatusText();
        }
      });
    });

    // Handle key bindings
    this.textArea.key('C-s', async () => {
      await this.saveContent();
    });

    this.textArea.key('C-a', () => {
      this.autoSaveEnabled = !this.autoSaveEnabled;
      if (this.autoSaveEnabled) {
        this.startAutoSave();
        this.updateStatusText('Auto-save enabled');
      } else {
        this.stopAutoSave();
        this.updateStatusText('Auto-save disabled');
      }
    });

    this.textArea.key('C-c', () => {
      this.clearContent();
    });

    // Focus the text area
    this.textArea.focus();

    // Update counts and status
    this.updateCounts();
    this.updateStatusText();
  }

  /**
   * Update word and character counts
   */
  private updateCounts(): void {
    this.charCount = this.content.length;
    this.wordCount = this.content
      .trim()
      .split(/\s+/)
      .filter(word => word.length > 0).length;
  }

  /**
   * Update the status text
   * @param message Optional message to display
   */
  private updateStatusText(message?: string): void {
    if (!this.statusText) {
      return;
    }

    const autoSaveStatus = this.autoSaveEnabled ? 'Auto-save: ON' : 'Auto-save: OFF';
    const countText = `Words: ${this.wordCount}, Characters: ${this.charCount}`;
    
    if (message) {
      this.statusText.setContent(`Focus Mode | ${message} | ${autoSaveStatus} | ${countText}`);
    } else if (this.isSaving) {
      this.statusText.setContent(`Focus Mode | Saving... | ${autoSaveStatus} | ${countText}`);
    } else {
      this.statusText.setContent(`Focus Mode | ${autoSaveStatus} | ${countText}`);
    }

    this.screen.render();
  }

  /**
   * Save the content
   */
  private async saveContent(): Promise<void> {
    if (this.isSaving || !this.content.trim()) {
      return;
    }

    this.isSaving = true;
    this.updateStatusText();

    try {
      await addContent(this.content);
      this.updateStatusText('Content saved successfully');
    } catch (err) {
      this.updateStatusText(`Error saving content: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSaving = false;
      
      // Reset status after 3 seconds
      setTimeout(() => {
        this.updateStatusText();
      }, 3000);
    }
  }

  /**
   * Clear the content
   */
  private clearContent(): void {
    this.content = '';
    if (this.textArea) {
      this.textArea.setValue('');
    }
    this.updateCounts();
    this.updateStatusText('Content cleared');
  }

  /**
   * Start the auto-save timer
   */
  private startAutoSave(): void {
    this.stopAutoSave();
    this.autoSaveTimer = setInterval(async () => {
      if (this.content.trim()) {
        await this.saveContent();
      }
    }, this.autoSaveInterval);
  }

  /**
   * Stop the auto-save timer
   */
  private stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * Get help text for this mode
   * @returns The help text
   */
  getHelpText(): string {
    return `
{bold}Focus Mode Help{/bold}

Focus mode provides a distraction-free environment for writing and thinking.

{bold}Commands:{/bold}
  {cyan-fg}/save{/cyan-fg} - Save the current content
  {cyan-fg}/clear{/cyan-fg} - Clear the current content
  {cyan-fg}/autosave [off|seconds]{/cyan-fg} - Toggle auto-save or set interval
  {cyan-fg}/wordcount{/cyan-fg} - Display word and character counts

{bold}Keybindings:{/bold}
  {cyan-fg}Ctrl+s{/cyan-fg} - Save content
  {cyan-fg}Ctrl+a{/cyan-fg} - Toggle auto-save
  {cyan-fg}Ctrl+c{/cyan-fg} - Clear content
  {cyan-fg}Esc{/cyan-fg} - Exit focus mode
`;
  }
}
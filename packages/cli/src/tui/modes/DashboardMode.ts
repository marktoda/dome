import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { BaseMode, ModeConfig } from './BaseMode';
import { listNotes, listTasks, search } from '../../utils/api';
import { formatDate } from '../../utils/ui';

/**
 * Dashboard mode for overview of notes, tasks, and recent activity
 */
export class DashboardMode extends BaseMode {
  private grid: any | null = null;
  private notesList: blessed.Widgets.ListElement | null = null;
  private tasksList: blessed.Widgets.ListElement | null = null;
  private activityLog: blessed.Widgets.BoxElement | null = null;
  private statsText: blessed.Widgets.TextElement | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private isLoading: boolean = false;
  private notes: any[] = [];
  private tasks: any[] = [];
  private recentActivity: any[] = [];
  private stats = {
    totalNotes: 0,
    totalTasks: 0,
    completedTasks: 0,
    pendingTasks: 0,
  };

  /**
   * Create a new dashboard mode
   * @param screen The blessed screen
   */
  constructor(screen: blessed.Widgets.Screen) {
    const config: ModeConfig = {
      name: 'Dashboard',
      description: 'Overview of notes, tasks, and recent activity',
      icon: '📊',
      color: 'cyan',
      keybindings: {
        'Ctrl+r': 'Refresh dashboard',
        'Ctrl+n': 'View notes',
        'Ctrl+t': 'View tasks',
        'Ctrl+a': 'View activity',
      },
      commands: ['refresh', 'notes', 'tasks', 'activity'],
    };
    
    super(config, screen);
  }

  /**
   * Handle mode activation
   */
  protected onActivate(): void {
    // Load data when activated
    this.loadData();
    
    // Set up auto-refresh timer (every 5 minutes)
    this.refreshTimer = setInterval(() => {
      this.loadData();
    }, 5 * 60 * 1000);
  }

  /**
   * Handle mode deactivation
   */
  protected onDeactivate(): void {
    // Clear auto-refresh timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Handle input in this mode
   * @param input The input to handle
   */
  async handleInput(input: string): Promise<void> {
    // Dashboard mode doesn't handle direct input
    // It's primarily a view-only mode
    return;
  }

  /**
   * Handle a command in this mode
   * @param command The command to handle
   * @param args The command arguments
   */
  async handleCommand(command: string, args: string[]): Promise<boolean> {
    switch (command) {
      case 'refresh':
        await this.loadData();
        return true;

      case 'notes':
        this.focusNotes();
        return true;

      case 'tasks':
        this.focusTasks();
        return true;

      case 'activity':
        this.focusActivity();
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
    // Create a grid layout for the dashboard
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    // Create a notes list
    this.notesList = this.grid.set(0, 0, 6, 6, blessed.list, {
      parent: container,
      label: ' Recent Notes ',
      tags: true,
      keys: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
        selected: {
          bg: 'cyan',
          fg: 'black',
        },
        item: {
          fg: 'white',
        },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '│',
        style: {
          fg: 'cyan',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    // Create a tasks list
    this.tasksList = this.grid.set(0, 6, 6, 6, blessed.list, {
      parent: container,
      label: ' Tasks ',
      tags: true,
      keys: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
        selected: {
          bg: 'cyan',
          fg: 'black',
        },
        item: {
          fg: 'white',
        },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '│',
        style: {
          fg: 'cyan',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    // Create an activity log
    this.activityLog = this.grid.set(6, 0, 4, 12, blessed.log, {
      parent: container,
      label: ' Recent Activity ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: '│',
        style: {
          fg: 'cyan',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    // Create a stats text
    this.statsText = this.grid.set(10, 0, 2, 12, blessed.text, {
      parent: container,
      label: ' Statistics ',
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
      },
      content: 'Loading statistics...',
    });

    // Set up key bindings
    this.notesList?.key('enter', () => {
      if (this.notesList && this.notes.length > 0) {
        // Get selected index from the list
        const selectedIndex = (this.notesList as any).selected || 0;
        if (selectedIndex >= 0 && selectedIndex < this.notes.length) {
          this.viewNoteDetails(this.notes[selectedIndex]);
        }
      }
    });

    this.tasksList?.key('enter', () => {
      if (this.tasksList && this.tasks.length > 0) {
        // Get selected index from the list
        const selectedIndex = (this.tasksList as any).selected || 0;
        if (selectedIndex >= 0 && selectedIndex < this.tasks.length) {
          this.viewTaskDetails(this.tasks[selectedIndex]);
        }
      }
    });

    this.notesList?.key('C-r', () => {
      this.loadData();
    });

    this.tasksList?.key('C-r', () => {
      this.loadData();
    });

    this.activityLog?.key('C-r', () => {
      this.loadData();
    });

    // Load initial data
    this.loadData();
  }

  /**
   * Load dashboard data
   */
  private async loadData(): Promise<void> {
    if (this.isLoading) {
      return;
    }

    this.isLoading = true;
    this.updateStatus('Loading data...');

    try {
      // Load notes
      const notesResponse = await listNotes();
      this.notes = Array.isArray(notesResponse) ? notesResponse : (notesResponse as any).notes || [];
      this.stats.totalNotes = this.notes.length;

      // Load tasks
      const tasksResponse = await listTasks();
      this.tasks = Array.isArray(tasksResponse) ? tasksResponse : (tasksResponse as any).tasks || [];
      this.stats.totalTasks = this.tasks.length;
      this.stats.completedTasks = this.tasks.filter(task => task.status === 'completed').length;
      this.stats.pendingTasks = this.stats.totalTasks - this.stats.completedTasks;

      // Load recent activity (using search with empty query to get recent items)
      const activityResponse = await search('');
      this.recentActivity = activityResponse.results || [];

      // Update UI
      this.updateNotesList();
      this.updateTasksList();
      this.updateActivityLog();
      this.updateStats();

      this.updateStatus('Data loaded successfully');
    } catch (err) {
      this.updateStatus(`Error loading data: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isLoading = false;
      
      // Reset status after 3 seconds
      setTimeout(() => {
        this.updateStatus('');
      }, 3000);
    }
  }

  /**
   * Update the notes list
   */
  private updateNotesList(): void {
    if (!this.notesList) {
      return;
    }

    this.notesList.clearItems();

    if (this.notes.length === 0) {
      this.notesList.addItem('{gray-fg}No notes found{/gray-fg}');
      return;
    }

    this.notes.slice(0, 20).forEach(note => {
      const title = note.title || 'Untitled';
      const date = formatDate(note.createdAt || note.created_at || new Date());
      const excerpt = note.body || note.content || '';
      const truncatedExcerpt = excerpt.length > 30 ? excerpt.substring(0, 30) + '...' : excerpt;
      
      this.notesList?.addItem(`{bold}${title}{/bold} (${date})\n${truncatedExcerpt}`);
    });

    this.screen.render();
  }

  /**
   * Update the tasks list
   */
  private updateTasksList(): void {
    if (!this.tasksList) {
      return;
    }

    this.tasksList.clearItems();

    if (this.tasks.length === 0) {
      this.tasksList.addItem('{gray-fg}No tasks found{/gray-fg}');
      return;
    }

    this.tasks.slice(0, 20).forEach(task => {
      const title = task.title || task.description || 'Untitled task';
      const status = task.status || 'unknown';
      const date = formatDate(task.createdAt || task.created_at || new Date());
      const statusColor = status === 'completed' ? 'green' : status === 'in_progress' ? 'yellow' : 'red';
      
      this.tasksList?.addItem(`{${statusColor}-fg}[${status}]{/${statusColor}-fg} {bold}${title}{/bold} (${date})`);
    });

    this.screen.render();
  }

  /**
   * Update the activity log
   */
  private updateActivityLog(): void {
    if (!this.activityLog) {
      return;
    }

    if (!this.activityLog) {
      return;
    }

    let content = '';

    if (this.recentActivity.length === 0) {
      content = '{gray-fg}No recent activity{/gray-fg}';
    } else {
      this.recentActivity.slice(0, 10).forEach(activity => {
        const type = activity.type || 'item';
        const title = activity.title || 'Untitled';
        const date = formatDate(activity.createdAt || activity.created_at || new Date());
        const typeColor = type === 'note' ? 'cyan' : type === 'task' ? 'yellow' : 'white';
        
        content += `[${date}] {${typeColor}-fg}${type}{/${typeColor}-fg}: {bold}${title}{/bold}\n`;
      });
    }

    this.activityLog.setContent(content);

    this.screen.render();
  }

  /**
   * Update the stats text
   */
  private updateStats(): void {
    if (!this.statsText) {
      return;
    }

    const content = `
{bold}Notes:{/bold} ${this.stats.totalNotes} total
{bold}Tasks:{/bold} ${this.stats.totalTasks} total (${this.stats.completedTasks} completed, ${this.stats.pendingTasks} pending)
{bold}Last updated:{/bold} ${formatDate(new Date())}
`;

    this.statsText.setContent(content);
    this.screen.render();
  }

  /**
   * Update status message
   * @param message The status message
   */
  private updateStatus(message: string): void {
    if (!this.statsText) {
      return;
    }

    const content = message ? message : `
{bold}Notes:{/bold} ${this.stats.totalNotes} total
{bold}Tasks:{/bold} ${this.stats.totalTasks} total (${this.stats.completedTasks} completed, ${this.stats.pendingTasks} pending)
{bold}Last updated:{/bold} ${formatDate(new Date())}
`;

    this.statsText.setContent(content);
    this.screen.render();
  }

  /**
   * View note details
   * @param note The note to view
   */
  private viewNoteDetails(note: any): void {
    const modal = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '80%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      scrollbar: {
        ch: '│',
        style: {
          fg: 'cyan',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    const title = note.title || 'Untitled';
    const content = note.body || note.content || '';
    const date = formatDate(note.createdAt || note.created_at || new Date());
    const tags = note.tags ? note.tags.join(', ') : '';

    modal.setContent(`
{bold}${title}{/bold}
{gray-fg}Created: ${date}{/gray-fg}
${tags ? `{gray-fg}Tags: ${tags}{/gray-fg}` : ''}

${content}

{center}{gray-fg}Press Escape to close{/gray-fg}{/center}
`);

    modal.key(['escape', 'q'], () => {
      this.screen.remove(modal);
      this.screen.render();
    });

    this.screen.render();
  }

  /**
   * View task details
   * @param task The task to view
   */
  private viewTaskDetails(task: any): void {
    const modal = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '80%',
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      scrollbar: {
        ch: '│',
        style: {
          fg: 'cyan',
        },
        track: {
          style: {
            fg: 'gray',
          },
        },
      },
    });

    const title = task.title || task.description || 'Untitled task';
    const description = task.description || task.content || '';
    const status = task.status || 'unknown';
    const date = formatDate(task.createdAt || task.created_at || new Date());
    const dueDate = task.dueDate || task.due_date ? formatDate(task.dueDate || task.due_date) : 'None';
    const statusColor = status === 'completed' ? 'green' : status === 'in_progress' ? 'yellow' : 'red';

    modal.setContent(`
{bold}${title}{/bold}
{gray-fg}Created: ${date}{/gray-fg}
{gray-fg}Due: ${dueDate}{/gray-fg}
{${statusColor}-fg}Status: ${status}{/${statusColor}-fg}

${description}

{center}{gray-fg}Press Escape to close{/gray-fg}{/center}
`);

    modal.key(['escape', 'q'], () => {
      this.screen.remove(modal);
      this.screen.render();
    });

    this.screen.render();
  }

  /**
   * Focus the notes list
   */
  private focusNotes(): void {
    if (this.notesList) {
      this.notesList.focus();
    }
  }

  /**
   * Focus the tasks list
   */
  private focusTasks(): void {
    if (this.tasksList) {
      this.tasksList.focus();
    }
  }

  /**
   * Focus the activity log
   */
  private focusActivity(): void {
    if (this.activityLog) {
      this.activityLog.focus();
    }
  }

  /**
   * Get help text for this mode
   * @returns The help text
   */
  getHelpText(): string {
    return `
{bold}Dashboard Mode Help{/bold}

Dashboard mode provides an overview of your notes, tasks, and recent activity.

{bold}Commands:{/bold}
  {cyan-fg}/refresh{/cyan-fg} - Refresh dashboard data
  {cyan-fg}/notes{/cyan-fg} - Focus the notes list
  {cyan-fg}/tasks{/cyan-fg} - Focus the tasks list
  {cyan-fg}/activity{/cyan-fg} - Focus the activity log

{bold}Keybindings:{/bold}
  {cyan-fg}Ctrl+r{/cyan-fg} - Refresh dashboard
  {cyan-fg}Ctrl+n{/cyan-fg} - Focus notes list
  {cyan-fg}Ctrl+t{/cyan-fg} - Focus tasks list
  {cyan-fg}Ctrl+a{/cyan-fg} - Focus activity log
  {cyan-fg}Enter{/cyan-fg} - View details of selected item
`;
  }
}
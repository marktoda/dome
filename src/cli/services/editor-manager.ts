import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { basename, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { getInkIO } from '../ink/ink-io.js';
import { toAbs, toRel, RelPath } from '../../core/utils/path-utils.js';
import { NoteService } from '../../core/services/NoteService.js';
import { createNoOpEventBus } from '../../core/events/index.js';
import type { NoteId } from '../../core/entities/Note.js';
import logger from '../../core/utils/logger.js';
import { NoteSearchService } from '../../core/services/NoteSearchService.js';

export interface EditorOptions {
  path: string;
  isNew?: boolean;
  onOpen?: () => void;
  onClose?: (success: boolean) => void;
  onError?: (error: Error) => void;
}

export interface EditorState {
  isOpen: boolean;
  isTransitioning: boolean;
  editorPid?: number;
  lastCloseTime: number;
}

/**
 * EditorManager provides clean integration between the TUI and external editors.
 * It manages terminal state transitions, keyboard input coordination, and
 * provides event-based feedback to the TUI.
 */
export class EditorManager extends EventEmitter {
  private state: EditorState = {
    isOpen: false,
    isTransitioning: false,
    lastCloseTime: 0,
  };

  private activeProcess: ChildProcess | null = null;
  private transitionTimeoutId: NodeJS.Timeout | null = null;
  private noteService: NoteService;


  constructor() {
    super();
    this.noteService = new NoteService(createNoOpEventBus());
  }

  /**
   * Get the current editor state
   */
  getState(): Readonly<EditorState> {
    return { ...this.state };
  }

  /**
   * Check if enough time has passed since the last editor close
   * to avoid phantom keystrokes
   */
  canOpenEditor(minDelayMs: number = 500): boolean {
    return Date.now() - this.state.lastCloseTime >= minDelayMs;
  }

  /**
   * Open a note in the external editor with proper terminal state management
   */
  async openEditor(options: EditorOptions): Promise<boolean> {
    const { path, isNew = false, onOpen, onClose, onError } = options;

    // Prevent concurrent editor sessions
    if (this.state.isOpen || this.state.isTransitioning) {
      const error = new Error('Editor is already open or transitioning');
      onError?.(error);
      this.emit('error', error);
      return false;
    }

    try {
      // Mark as transitioning
      this.setState({ isTransitioning: true });
      this.emit('transition:start');

      // Detect editor
      const editor = this.detectEditor();
      const fullPath = toAbs(path as RelPath);

      // Ensure directory exists
      await mkdir(dirname(fullPath), { recursive: true });

      // Create new file if needed
      if (isNew) {
        await this.createNoteTemplate(path);
      }

      // Prepare terminal for external editor
      const terminalState = await this.prepareTerminal();

      // Spawn editor process
      const args = this.getEditorArgs(editor, fullPath);
      this.activeProcess = spawn(editor, args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          // Ensure editor gets proper terminal environment
          TERM: process.env.TERM || 'xterm-256color',
        },
      });

      const pid = this.activeProcess.pid;
      if (!pid) {
        throw new Error('Failed to spawn editor process');
      }

      // Update state
      this.setState({
        isOpen: true,
        isTransitioning: false,
        editorPid: pid,
      });

      this.emit('editor:opened', { pid, path });
      onOpen?.();

      // Wait for editor to close
      return new Promise(resolve => {
        this.activeProcess!.on('exit', async code => {
          const success = code === 0;

          // Begin cleanup transition
          this.setState({ isTransitioning: true });
          this.emit('transition:start');

          // Restore terminal state
          await this.restoreTerminal(terminalState);

          // Update state with delay to prevent phantom keystrokes
          this.transitionTimeoutId = setTimeout(() => {
            this.setState({
              isOpen: false,
              isTransitioning: false,
              editorPid: undefined,
              lastCloseTime: Date.now(),
            });

            this.emit('editor:closed', { success, path });
            onClose?.(success);

            resolve(success);
          }, 100); // Small delay for terminal stabilization
        });

        this.activeProcess!.on('error', error => {
          this.handleProcessError(error, terminalState, onError);
          resolve(false);
        });
      });
    } catch (error) {
      // Ensure we clean up state on any error
      this.setState({
        isOpen: false,
        isTransitioning: false,
        editorPid: undefined,
        lastCloseTime: Date.now(),
      });

      const err = error instanceof Error ? error : new Error('Unknown error');
      this.emit('error', err);
      onError?.(err);
      return false;
    }
  }

  /**
   * Force close the editor if it's open
   */
  async forceClose(): Promise<void> {
    if (this.activeProcess && !this.activeProcess.killed) {
      this.activeProcess.kill('SIGTERM');

      // Give it time to close gracefully
      await new Promise(resolve => setTimeout(resolve, 100));

      // Force kill if still running
      if (!this.activeProcess.killed) {
        this.activeProcess.kill('SIGKILL');
      }
    }

    // Clear any pending transition timeout
    if (this.transitionTimeoutId) {
      clearTimeout(this.transitionTimeoutId);
      this.transitionTimeoutId = null;
    }

    // Reset state
    this.setState({
      isOpen: false,
      isTransitioning: false,
      editorPid: undefined,
      lastCloseTime: Date.now(),
    });
  }

  private setState(updates: Partial<EditorState>): void {
    this.state = { ...this.state, ...updates };
    this.emit('state:changed', this.state);
  }

  private detectEditor(): string {
    return (
      process.env.EDITOR ||
      process.env.VISUAL ||
      (process.platform === 'win32' ? 'notepad' : 'nano')
    );
  }

  private getEditorArgs(editor: string, fullPath: string): string[] {
    const editorName = basename(editor);

    // Special handling for common editors that need wait flags
    switch (editorName) {
      case 'code':
      case 'code.cmd':
        return ['--wait', fullPath];
      case 'subl':
      case 'subl.exe':
        return ['--wait', fullPath];
      case 'atom':
      case 'atom.cmd':
        return ['--wait', fullPath];
      default:
        return [fullPath];
    }
  }

  private async createNoteTemplate(path: string): Promise<void> {
    const title = basename(path, '.md')
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    const content = `# ${title}\n\n`;

    try {
      await this.noteService.writeNote(toRel(path) as NoteId, content);
      logger.debug(`Created note template for: ${path}`);
    } catch (error) {
      logger.error('Failed to create note template:', error);
      throw error;
    }
  }

  private async prepareTerminal(): Promise<any> {
    const io = getInkIO();
    if (!io) {
      logger.warn('No Ink IO available, using process streams');
      return null;
    }

    const stdin = io.stdin ?? process.stdin;
    const stdout = process.stdout;
    const stdinAny = stdin as any;

    // Capture current terminal state
    const terminalState = {
      wasRaw: io.isRawModeSupported && stdinAny.isRaw,
      wasListening: stdinAny.isPaused ? !stdinAny.isPaused() : true,
      originalWrite: stdout.write.bind(stdout),
    };

    try {
      // 1. Exit raw mode if active
      if (terminalState.wasRaw && io.setRawMode) {
        io.setRawMode(false);
      }

      // 2. Pause stdin to stop Ink from processing input
      stdin.pause();

      // 3. Clear any pending input
      if (stdinAny.read) {
        while (stdinAny.read() !== null) {
          // Drain input buffer
        }
      }

      // 4. Exit alternate screen buffer (if in use)
      stdout.write('\u001b[?1049l');

      // 5. Show cursor
      stdout.write('\u001b[?25h');

      // 6. Temporarily disable stdout writes from Ink
      (stdout as any).write = (..._args: any[]) => true;

      return terminalState;
    } catch (error) {
      logger.error('Failed to prepare terminal:', error);
      return terminalState;
    }
  }

  private async restoreTerminal(terminalState: any): Promise<void> {
    if (!terminalState) return;

    const io = getInkIO();
    const stdin = io?.stdin || process.stdin;
    const stdout = process.stdout;

    try {
      // 1. Restore stdout write function
      if (terminalState.originalWrite) {
        (stdout as any).write = terminalState.originalWrite;
      }

      // 2. Return to alternate screen buffer
      stdout.write('\u001b[?1049h');

      // 3. Previously we cleared the screen here to remove any artifacts left
      //    by the external editor. Unfortunately, that also wipes everything
      //    that Ink has already rendered – effectively erasing the chat
      //    history from the alternate screen buffer. The alternate buffer
      //    already gets restored to its previous contents when we re-enter it
      //    (sequence \u001b[?1049h above), so we can safely skip the extra
      //    clear without leaving stray editor output.
      //    Removing this command preserves the chat history for the user.

      // NOTE: If any residual artefacts from certain editors become a problem
      //       in future, consider forcing a React refresh instead of a hard
      //       terminal clear so that Ink re-renders the current frame.

      // 4. Resume stdin for Ink input handling
      if (terminalState.wasListening) {
        stdin.resume();
      }

      // 5. Restore raw mode if it was active
      if (terminalState.wasRaw && io?.setRawMode) {
        // Small delay before re-enabling raw mode
        await new Promise(resolve => setTimeout(resolve, 50));
        io.setRawMode(true);
      }

      // 6. Force a small delay to let terminal stabilize
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (error) {
      logger.error('Failed to restore terminal:', error);
    }
  }

  private handleProcessError(
    error: Error,
    terminalState: any,
    onError?: (error: Error) => void
  ): void {
    logger.error('Editor process error:', error);

    // Attempt to restore terminal
    this.restoreTerminal(terminalState).catch(err => {
      logger.error('Failed to restore terminal after error:', err);
    });

    // Reset state
    this.setState({
      isOpen: false,
      isTransitioning: false,
      editorPid: undefined,
      lastCloseTime: Date.now(),
    });

    this.emit('error', error);
    onError?.(error);
  }
}

// Singleton instance
export const editorManager = new EditorManager();

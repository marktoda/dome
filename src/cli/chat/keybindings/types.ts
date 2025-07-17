// Key combination representation
export interface KeyCombination {
  key?: string;           // The key itself (e.g., 'a', 'Enter', 'Tab')
  ctrl?: boolean;         // Ctrl/Cmd modifier
  shift?: boolean;        // Shift modifier
  alt?: boolean;          // Alt/Option modifier
  meta?: boolean;         // Meta/Windows/Command modifier
  upArrow?: boolean;      // Arrow keys
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  tab?: boolean;          // Tab key
  escape?: boolean;       // Escape key
  return?: boolean;       // Enter/Return key
  backspace?: boolean;    // Backspace key
  delete?: boolean;       // Delete key
  pageUp?: boolean;       // Page up
  pageDown?: boolean;     // Page down
}

// Keybinding definition
export interface Keybinding {
  id: string;                      // Unique identifier
  keys: KeyCombination;            // Key combination
  command: string;                 // Command to execute
  when?: string;                   // Context condition (e.g., "!editorOpen")
  description?: string;            // Human-readable description
  group?: string;                  // Grouping for help display
  args?: Record<string, any>;      // Optional arguments for the command
}

// Command definition
export interface Command {
  id: string;                      // Unique identifier (matches keybinding command)
  handler: CommandHandler;         // Function to execute
  description?: string;            // Human-readable description
  group?: string;                  // Grouping for help display
}

// Command handler function type
export type CommandHandler = (args?: Record<string, any>) => void | Promise<void>;

// Context for evaluating "when" conditions
export interface KeybindingContext {
  editorOpen: boolean;
  editorTransitioning: boolean;
  processing: boolean;
  hasMessages: boolean;
  hasNoteLog: boolean;
  noteLogVisible: boolean;
  helpVisible: boolean;
  activityVisible: boolean;
  selectedMessageIndex: number | null;
  inputFocused: boolean;
}

// Keybinding registry
export interface KeybindingRegistry {
  register(binding: Keybinding): void;
  unregister(id: string): void;
  getBindings(): Keybinding[];
  getBindingsByGroup(group: string): Keybinding[];
  findBinding(keys: KeyCombination, context: KeybindingContext): Keybinding | undefined;
}

// Command registry
export interface CommandRegistry {
  register(command: Command): void;
  unregister(id: string): void;
  execute(commandId: string, args?: Record<string, any>): Promise<void>;
  getCommand(id: string): Command | undefined;
  getCommands(): Command[];
  getCommandsByGroup(group: string): Command[];
} 
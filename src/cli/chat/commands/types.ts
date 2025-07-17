// Chat command definition
export interface ChatCommand {
  name: string;                     // Command name (e.g., 'help', 'exit')
  aliases?: string[];               // Alternative names (e.g., ['quit', 'q'] for exit)
  description: string;              // Help text
  usage?: string;                   // Usage example
  handler: ChatCommandHandler;      // Function to execute
  group?: string;                   // Grouping for help display
  hidden?: boolean;                 // Hide from help listing
}

// Chat command handler function type
export type ChatCommandHandler = (args: string[], context: ChatCommandContext) => void | Promise<void>;

// Context provided to chat command handlers
export interface ChatCommandContext {
  addMessage: (message: {
    type: 'user' | 'assistant' | 'system' | 'error';
    content: string;
  }) => void;
  exit: () => void;
  clearMessages: () => void;
  showHelp: () => void;
  toggleTimestamps: (mode: 'off' | 'relative' | 'absolute') => void;
  getState: () => any; // Access to current state
}

// Chat command registry
export interface ChatCommandRegistry {
  register(command: ChatCommand): void;
  unregister(name: string): void;
  execute(input: string, context: ChatCommandContext): Promise<boolean>;
  getCommand(name: string): ChatCommand | undefined;
  getCommands(): ChatCommand[];
  getCommandsByGroup(group: string): ChatCommand[];
  isCommand(input: string): boolean;
} 
#!/usr/bin/env node

import { TUI } from './core';
import { ChatMode, ExploreMode, NoteMode } from './modes';
import { 
  HelpCommand, 
  AddCommand, 
  SearchCommand, 
  ListCommand, 
  ModeCommand,
  ExitCommand
} from './commands';

/**
 * Start the TUI
 */
export function startTui(): void {
  // Create the TUI
  const tui = new TUI();
  
  // Get the TUI context
  const context = tui.getContext();
  
  // Register modes
  tui.registerModes([
    new ChatMode(),
    new ExploreMode(),
    new NoteMode()
  ]);
  
  // Register commands
  tui.registerCommands([
    new HelpCommand(tui.getModeManager(), tui.getCommandManager(), context.addMessage),
    new AddCommand(context.addMessage, context.setStatus),
    new SearchCommand(context.addMessage, context.setStatus),
    new ListCommand(context.addMessage, context.setStatus),
    new ModeCommand(tui.getModeManager(), context.addMessage),
    new ExitCommand()
  ]);
  
  // Start the TUI with chat mode as default
  tui.start('chat');
}

/**
 * Start the prompt-based TUI (for backward compatibility)
 */
export function startPromptTui(): void {
  startTui();
}

// If this file is run directly, start the TUI
if (require.main === module) {
  startTui();
}
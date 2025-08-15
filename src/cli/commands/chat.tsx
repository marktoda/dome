import React from 'react';
import { render } from 'ink';
import { ChatApp } from '../chat/index.js';
import logger from '../../core/utils/logger.js';

/**
 * Restore terminal to normal state after TUI exit
 */
function cleanupTerminal(): void {
  try {
    // Exit alternate screen buffer (if in use)
    process.stdout.write('\u001b[?1049l');

    // Show cursor
    process.stdout.write('\u001b[?25h');

    // Reset terminal to default state
    process.stdout.write('\u001bc');

    // Ensure stdin is not in raw mode
    if (process.stdin.isTTY && (process.stdin as any).setRawMode) {
      (process.stdin as any).setRawMode(false);
    }

    // Resume stdin if paused
    if (process.stdin.isPaused && process.stdin.isPaused()) {
      process.stdin.resume();
    }
  } catch (error) {
    // Silently ignore cleanup errors
  }
}

export async function handleChat(): Promise<void> {
  // Set up cleanup handlers for unexpected exits
  const cleanup = () => {
    cleanupTerminal();
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);

  // Handle uncaught exceptions
  process.on('uncaughtException', error => {
    cleanupTerminal();
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  try {
    // Clear the screen first
    process.stdout.write('\u001B[2J\u001B[0;0f');

    // Set logger to warn level for cleaner TUI output
    logger.level = 'warn';

    // Use fullscreen mode to prevent flickering and ensure proper layout
    const { waitUntilExit } = render(<ChatApp />, {
      exitOnCtrlC: false, // We handle exit in the app
      // Enable alternate screen buffer for better fullscreen experience
      stdout: process.stdout,
      stdin: process.stdin,
      debug: false,
    });

    await waitUntilExit();

    // Clean up terminal state after exit
    cleanupTerminal();
  } catch (error) {
    // Always try to clean up terminal even on error
    cleanupTerminal();

    logger.info('🏠 Dome AI Assistant');
    logger.error('❌ Error starting TUI interface:');
    logger.debug(error instanceof Error ? error.message : 'Unknown error');
    logger.info('Please ensure you are running this in a proper terminal.');
  } finally {
    // Remove cleanup handlers
    process.removeListener('SIGTERM', cleanup);
    process.removeListener('SIGHUP', cleanup);
  }
}

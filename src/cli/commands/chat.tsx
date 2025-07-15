import React from 'react';
import { render } from 'ink';
import { ChatApp } from '../chat/index.js';
import logger from '../../mastra/utils/logger.js';

export async function handleChat(): Promise<void> {
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
      debug: false
    });

    await waitUntilExit();
  } catch (error) {
    logger.info('🏠 Dome AI Assistant');
    logger.error('❌ Error starting TUI interface:');
    logger.debug(error instanceof Error ? error.message : 'Unknown error');
    logger.info('Please ensure you are running this in a proper terminal.');
  }
}

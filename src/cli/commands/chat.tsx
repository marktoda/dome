import React from 'react';
import { render } from 'ink';
import { ChatApp } from '../chat/index.js';

export async function handleChat(): Promise<void> {
  try {
    // Clear the screen first
    console.clear();
    
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
    console.log('🏠 Dome AI Assistant');
    console.log('❌ Error starting TUI interface:', error instanceof Error ? error.message : 'Unknown error');
    console.log('Please ensure you are running this in a proper terminal.');
  }
}
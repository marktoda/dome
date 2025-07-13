import React from 'react';
import { render } from 'ink';
import { ChatApp } from '../components/ChatApp.js';

export async function handleChat(): Promise<void> {
  try {
    // Use fullscreen mode to prevent flickering and ensure proper layout
    const { waitUntilExit } = render(<ChatApp />, {
      exitOnCtrlC: false // We handle exit in the app
    });
    
    await waitUntilExit();
  } catch (error) {
    console.log('🏠 Dome AI Assistant');
    console.log('❌ Error starting TUI interface:', error instanceof Error ? error.message : 'Unknown error');
    console.log('Please ensure you are running this in a proper terminal.');
  }
}
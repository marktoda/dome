import React from 'react';
import { render } from 'ink';
import { ChatApp } from '../components/ChatApp.js';

export async function handleChat(): Promise<void> {
  try {
    render(<ChatApp />);
  } catch (error) {
    console.log('🏠 Dome AI Assistant');
    console.log('❌ Error starting TUI interface:', error instanceof Error ? error.message : 'Unknown error');
    console.log('Please ensure you are running this in a proper terminal.');
  }
}
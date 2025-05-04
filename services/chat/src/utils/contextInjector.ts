/**
 * Context Injector Module
 *
 * This module provides utilities for injecting situational context into LLM prompts,
 * such as time, user information, and location data.
 */

/**
 * User data interface for context injection
 */
export interface UserContextData {
  name?: string;
  location?: string;
  [key: string]: any; // Allow for additional user context fields
}

/**
 * Injects situational context into a prompt
 *
 * Adds a preamble with:
 * - Current date and time
 * - User's name (if available)
 * - User's location (if available)
 *
 * @param prompt - The original prompt to inject context into
 * @param userData - Optional user data containing name and location
 * @returns The prompt with injected situational context
 */
export function injectSituationalContext(prompt: string, userData?: UserContextData): string {
  // Get current date and time
  const now = new Date();
  const formattedDate = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const formattedTime = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  // Build context preamble
  let contextPreamble = `--- Situational Context ---\n`;
  contextPreamble += `Current Date: ${formattedDate}\n`;
  contextPreamble += `Current Time: ${formattedTime}\n`;

  // Add user information if available
  if (userData) {
    if (userData.name) {
      contextPreamble += `User: ${userData.name}\n`;
    }
    if (userData.location) {
      contextPreamble += `Location: ${userData.location}\n`;
    }
  }

  contextPreamble += `\n--- Original Prompt ---\n`;

  // Return prompt with context preamble
  return contextPreamble + prompt;
}

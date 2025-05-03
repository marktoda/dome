/**
 * Example of using the Situational Context Injector
 * This file shows how to integrate the context injector with chat requests
 */

import { getChatLLMPrompt } from '../config/promptsConfig';
import { UserContextData } from './contextInjector';

/**
 * Example function showing how to use the context injector with user data
 * 
 * @param userId - The ID of the user making the request
 * @param userLocation - Optional location of the user
 * @returns The system prompt with injected situational context
 */
export function generateContextEnrichedPrompt(
  userName?: string,
  userLocation?: string
): string {
  // Create user context data object
  const userData: UserContextData = {};
  
  // Add available user information
  if (userName) {
    userData.name = userName;
  }
  
  if (userLocation) {
    userData.location = userLocation;
  }
  
  // Get the chat prompt with situational context injected
  const contextEnrichedPrompt = getChatLLMPrompt(userData);
  
  return contextEnrichedPrompt;
}

/**
 * Example implementation showing how this might be used in a chat handler
 * This is for illustration purposes only.
 */
export function exampleChatHandler(request: any): any {
  // Extract user information from request context, user data, or headers
  // This is just an example - actual implementation would depend on your auth system
  const userName = request.user?.name || request.headers?.get('x-user-name');
  const userLocation = request.user?.location || request.headers?.get('x-user-location');
  
  // Generate the context-enriched system prompt
  const systemPrompt = generateContextEnrichedPrompt(userName, userLocation);
  
  // The prompt now contains:
  // - Current date and time
  // - User's name (if available)
  // - User's location (if available)
  
  // In a real implementation, you would then:
  // 1. Use this system prompt in your LLM call
  // 2. Process the LLM response
  // 3. Return the result to the user
  
  return {
    systemPrompt,
    // other response data...
  };
}
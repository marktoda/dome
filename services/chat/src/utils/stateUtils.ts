/**
 * Utility functions for working with state objects
 */

import { AgentState } from "../types";

/**
 * Safely get the userId from an agent state object,
 * handling potential structure changes
 * 
 * @param state The agent state object
 * @returns The userId or "unknown-user" if not found
 */
export function getUserId(state: AgentState): string {
  // Get userId from the unified structure
  if (state.userId) {
    return state.userId;
  }
  
  // Default fallback
  return "unknown-user";
}
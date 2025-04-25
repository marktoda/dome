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
  // Try to get userId from initialState (new structure)
  if (state.initialState && state.initialState.userId) {
    return state.initialState.userId;
  }
  
  // Legacy fallback (old structure)
  // @ts-ignore - For backward compatibility
  if (state.userId) {
    // @ts-ignore
    return state.userId;
  }
  
  // Default fallback
  return "unknown-user";
}
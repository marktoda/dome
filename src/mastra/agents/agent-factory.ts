/**
 * Agent factory for creating context-aware agents
 */

import { Agent } from '@mastra/core/agent';
import { notesAgent } from './notes-agent.js';
import { createContextAwareAgent } from './context-aware-agent.js';

/**
 * Get an agent for a specific context path
 * @param contextPath Optional path to determine context
 * @returns Agent instance configured for the context
 */
export async function getAgentForContext(contextPath?: string): Promise<Agent> {
  if (!contextPath) {
    // Return default agent if no context path
    return notesAgent;
  }
  
  // Create context-aware agent for the specific path
  return await createContextAwareAgent(contextPath);
}

/**
 * Get the default notes agent
 */
export function getDefaultAgent(): Agent {
  return notesAgent;
}
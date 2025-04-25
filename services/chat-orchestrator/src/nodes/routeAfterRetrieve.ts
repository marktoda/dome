import { getLogger } from '@dome/logging';
import { AgentState } from '../types';

/**
 * Determine the next step after retrieval
 * @returns 'widen' | 'tool' | 'answer'
 */
export const routeAfterRetrieve = (state: AgentState): 'widen' | 'tool' | 'answer' => {
  const logger = getLogger().child({ node: 'routeAfterRetrieve' });
  
  // Check if we need to widen search
  if (state.tasks?.needsWidening) {
    const wideningAttempts = state.tasks?.wideningAttempts || 0;
    logger.info(
      { 
        docsCount: state.docs?.length || 0,
        wideningAttempts,
      }, 
      'Need to widen search'
    );
    return 'widen';
  }
  
  // Check if we need to use a tool
  const query = state.tasks?.originalQuery || '';
  const toolIntent = detectToolIntent(query);
  
  if (toolIntent.needsTool) {
    logger.info(
      { 
        toolIntent,
        query,
      }, 
      'Detected tool intent'
    );
    
    // Update state with required tools
    state.tasks = {
      ...state.tasks,
      requiredTools: toolIntent.tools,
    };
    
    return 'tool';
  }
  
  // Default to generating an answer
  logger.info('Proceeding to answer generation');
  return 'answer';
};

/**
 * Detect if the query requires a tool
 * This is a simple implementation for Phase 1
 */
function detectToolIntent(query: string): { needsTool: boolean; tools: string[] } {
  // This would be more sophisticated in a real implementation
  // Could use an LLM or a classifier
  
  const toolPatterns = [
    { name: 'calculator', pattern: /calculate|compute|math|equation/i },
    { name: 'calendar', pattern: /schedule|appointment|meeting|calendar/i },
    { name: 'weather', pattern: /weather|temperature|forecast/i },
    { name: 'web_search', pattern: /search|find online|look up/i },
  ];
  
  const matchedTools = toolPatterns
    .filter(tool => tool.pattern.test(query))
    .map(tool => tool.name);
  
  return {
    needsTool: matchedTools.length > 0,
    tools: matchedTools,
  };
}
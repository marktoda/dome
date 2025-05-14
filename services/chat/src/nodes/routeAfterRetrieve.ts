import { getLogger } from '@dome/common';
import { Document } from '../types';
import { AgentStateV3 as AgentState } from '../types/stateSlices';
import { ObservabilityService } from '../services/observabilityService';

/**
 * Analyze retrieval results and determine the next step in the RAG pipeline
 * Options:
 * - 'widen' - initial retrieval wasn't sufficient, need to widen search parameters
 * - 'tool' - retrieval indicated tools are needed to fulfill the query
 * - 'answer' - retrieval was good enough to proceed to answer generation
 */
export const routeAfterRetrieve = async (
  state: AgentState,
): Promise<'widen' | 'tool' | 'answer'> => {
  const logger = getLogger().child({ node: 'routeAfterRetrieve' });
  const docs = state.docs || [];

  // Get task information - make taskIds optional
  const taskIds = state.taskIds || [];
  const taskEntities = state.taskEntities || {};

  // If no tasks exist, proceed to answer
  if (!taskEntities || Object.keys(taskEntities).length === 0) {
    logger.warn('No task entities found, proceeding to answer generation');
    return 'answer';
  }

  // Check if any task needs widening
  const needsWidening = taskIds.some(taskId => {
    const task = taskEntities[taskId];
    return task && task.needsWidening === true;
  });

  if (needsWidening) {
    logger.info(
      {
        docsCount: docs.length,
        reason: 'At least one task has needsWidening flag set',
      },
      'Routing to widening',
    );
    return 'widen';
  }

  // Assess document quality and quantity
  const retrievalQuality = assessRetrievalQuality(docs);

  // Determine if any task hasn't had sufficient widening attempts
  const insufficientWidening = taskIds.some(taskId => {
    const task = taskEntities[taskId];
    const wideningAttempts = task?.wideningAttempts || 0;

    // If retrieval quality is poor and we haven't tried widening too many times
    if (retrievalQuality === 'none' && wideningAttempts < 2) {
      return true;
    }

    // If retrieval quality is low and we haven't widened yet
    if (retrievalQuality === 'low' && wideningAttempts === 0) {
      return true;
    }

    return false;
  });

  if (insufficientWidening) {
    // Update all tasks that need widening
    const updatedTaskEntities = { ...taskEntities };

    taskIds.forEach(taskId => {
      const task = taskEntities[taskId];
      if (!task) return;

      const wideningAttempts = task.wideningAttempts || 0;

      if (
        (retrievalQuality === 'none' && wideningAttempts < 2) ||
        (retrievalQuality === 'low' && wideningAttempts === 0)
      ) {
        updatedTaskEntities[taskId] = {
          ...task,
          needsWidening: true,
        };
      }
    });

    // Update state with tasks that need widening
    state.taskEntities = updatedTaskEntities;

    logger.info(
      {
        docsCount: docs.length,
        retrievalQuality,
        reason: 'Insufficient widening attempts for retrieval quality',
      },
      'Routing to widening',
    );
    return 'widen';
  }

  // Check if any task might need a tool
  let needsTool = false;
  let toolIntent: { needsTool: boolean; tools: string[] } = { needsTool: false, tools: [] };

  for (const taskId of taskIds) {
    const task = taskEntities[taskId];
    if (!task) continue;

    const query = task.rewrittenQuery || task.originalQuery || '';

    // Check if the query likely needs a tool
    const taskToolIntent = detectToolIntent(query, docs);

    if (taskToolIntent.needsTool) {
      needsTool = true;
      toolIntent = taskToolIntent;

      // Update the task with required tools
      const updatedTaskEntities = { ...state.taskEntities };
      updatedTaskEntities[taskId] = {
        ...task,
        requiredTools: taskToolIntent.tools,
      };

      // Update state with the task requiring tools
      state.taskEntities = updatedTaskEntities;

      logger.info(
        {
          taskId,
          toolIntent,
          query,
          retrievalQuality,
        },
        'Task requires tools, routing to tool',
      );
      break;
    }
  }

  if (needsTool) {
    return 'tool';
  }

  // Default to generating an answer with available documents
  logger.info(
    {
      retrievalQuality,
      docsCount: docs.length,
      reason: 'Sufficient context or maximum widening attempts reached',
    },
    'Routing to answer generation',
  );

  return 'answer';
};

/**
 * Assess the quality of retrieved documents
 * @param docs Retrieved documents
 * @returns Quality assessment: 'high', 'low', or 'none'
 */
function assessRetrievalQuality(docs: Document[]): 'high' | 'low' | 'none' {
  if (docs.length === 0) {
    return 'none';
  }

  // Calculate average relevance score
  const relevanceScores = docs.map(doc => doc.metadata.relevanceScore || 0);
  const avgRelevance =
    relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length;

  // High quality: Good average relevance and sufficient number of documents
  if (avgRelevance > 0.7 && docs.length >= 3) {
    return 'high';
  }

  // Low quality: Some relevant documents but not ideal
  if (avgRelevance > 0.4 || docs.length >= 2) {
    return 'low';
  }

  // No quality: Very few or irrelevant documents
  return 'none';
}

/**
 * Detect if the query requires a tool based on query text and retrieved documents
 * This uses a more sophisticated approach that considers both query patterns
 * and the content of retrieved documents
 */
function detectToolIntent(
  query: string,
  docs: Document[],
): { needsTool: boolean; tools: string[] } {
  const logger = getLogger().child({ function: 'detectToolIntent' });

  // Tool patterns with regex and keyword indicators
  const toolPatterns = [
    {
      name: 'calculator',
      pattern: /calculate|compute|math|equation|sum|average|divide|multiply/i,
      keywords: ['calculate', 'compute', 'solve', 'equation', 'math', 'formula', 'result'],
    },
    {
      name: 'calendar',
      pattern: /schedule|appointment|meeting|calendar|remind|event/i,
      keywords: ['schedule', 'appointment', 'meeting', 'calendar', 'event', 'reminder'],
    },
    {
      name: 'weather',
      pattern: /weather|temperature|forecast|humidity|precipitation|rain|sunny/i,
      keywords: ['weather', 'forecast', 'temperature', 'precipitation', 'humidity'],
    },
    {
      name: 'web_search',
      pattern: /search|find online|look up|latest|current|news about/i,
      keywords: ['search', 'find', 'lookup', 'latest', 'current', 'information'],
    },
  ];

  // Check query patterns
  const queryMatchedTools = toolPatterns
    .filter(tool => tool.pattern.test(query))
    .map(tool => tool.name);

  // If we have direct matches from the query, return those
  if (queryMatchedTools.length > 0) {
    logger.info(
      {
        query,
        matchedTools: queryMatchedTools,
        method: 'query_pattern_match',
      },
      'Tool intent detected from query patterns',
    );
    return {
      needsTool: true,
      tools: queryMatchedTools,
    };
  }

  // Check if documents contain signals that tools might be needed
  if (docs.length > 0) {
    // Look for tool-related keywords in document content
    const toolMentions: Record<string, number> = {};

    // Count keyword occurrences across all docs
    for (const doc of docs) {
      const content = doc.content.toLowerCase();

      for (const tool of toolPatterns) {
        for (const keyword of tool.keywords) {
          if (content.includes(keyword)) {
            toolMentions[tool.name] = (toolMentions[tool.name] || 0) + 1;
          }
        }
      }
    }

    // Find tools mentioned across multiple documents or with high frequency
    const toolCandidates = Object.entries(toolMentions)
      .filter(([_, count]) => count >= 2) // Tool mentioned at least twice
      .map(([name, _]) => name);

    if (toolCandidates.length > 0) {
      logger.info(
        {
          toolCandidates,
          toolMentions,
          method: 'document_content_analysis',
        },
        'Tool intent detected from document content analysis',
      );
      return {
        needsTool: true,
        tools: toolCandidates,
      };
    }
  }

  // When retrieval quality is poor, use keyword matching as a fallback
  // This helps when documents don't provide enough context
  if (docs.length === 0 || assessRetrievalQuality(docs) === 'none') {
    // Simple keyword matching for common tool-related terms
    const calculatorTerms = /\b(calculate|compute|solve for)\b/i;
    const weatherTerms = /\b(weather forecast|temperature in|humidity in)\b/i;
    const searchTerms = /\b(latest info|current news|find information about)\b/i;

    if (calculatorTerms.test(query)) {
      return {
        needsTool: true,
        tools: ['calculator'],
      };
    }

    if (weatherTerms.test(query)) {
      return {
        needsTool: true,
        tools: ['weather'],
      };
    }

    if (searchTerms.test(query)) {
      return {
        needsTool: true,
        tools: ['web_search'],
      };
    }
  }

  // Default to no tool needed
  return {
    needsTool: false,
    tools: [],
  };
}

import { getLogger } from '@dome/logging';
import { ToolRegistry, ToolCategory, ToolDefinition } from './registry';

/**
 * Register default tools with the registry
 */
export function registerDefaultTools(): void {
  const logger = getLogger().child({ component: 'DefaultTools' });

  try {
    // Register calculator tool
    ToolRegistry.registerTool({
      name: 'calculator',
      description: 'Performs mathematical calculations',
      category: ToolCategory.CALCULATION,
      requiresAuth: false,
      parameters: [
        {
          name: 'expression',
          type: 'string',
          description: 'The mathematical expression to evaluate',
          required: true,
        },
      ],
      examples: ['Calculate 2 + 2', 'Compute the square root of 16', 'Find 15% of 200'],
      execute: async (input: { expression: string }) => {
        try {
          // Sanitize the expression to prevent code injection
          const sanitizedExpression = sanitizeMathExpression(input.expression);

          // Evaluate the expression
          // Using Function constructor is generally not recommended for security reasons,
          // but we're sanitizing the input and this is just for demonstration
          // In a production environment, use a proper math library
          const result = new Function(`return ${sanitizedExpression}`)();

          return {
            result,
            expression: input.expression,
          };
        } catch (error) {
          return {
            error: `Failed to calculate: ${error instanceof Error ? error.message : String(error)}`,
            expression: input.expression,
          };
        }
      },
    });

    // Register weather tool
    ToolRegistry.registerTool({
      name: 'weather',
      description: 'Gets current weather information for a location',
      category: ToolCategory.EXTERNAL_DATA,
      requiresAuth: false,
      parameters: [
        {
          name: 'location',
          type: 'string',
          description: 'The location to get weather for (city name or coordinates)',
          required: true,
        },
        {
          name: 'units',
          type: 'string',
          description: 'The units to use (metric, imperial, or standard)',
          required: false,
          default: 'metric',
        },
      ],
      examples: [
        'Get the weather in San Francisco',
        'Check the temperature in New York with imperial units',
        "What's the forecast for London?",
      ],
      execute: async (input: { location: string; units?: string }, env: Env) => {
        try {
          // In a real implementation, this would call a weather API
          // For Phase 3, we'll return mock data
          return mockWeatherData(input.location, input.units || 'metric');
        } catch (error) {
          return {
            error: `Failed to get weather: ${
              error instanceof Error ? error.message : String(error)
            }`,
            location: input.location,
          };
        }
      },
    });

    // Register web search tool
    ToolRegistry.registerTool({
      name: 'web_search',
      description: 'Searches the web for information',
      category: ToolCategory.SEARCH,
      requiresAuth: true,
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'The search query',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximum number of results to return',
          required: false,
          default: 5,
        },
      ],
      examples: [
        'Search for information about climate change',
        'Find recent news about artificial intelligence',
        'Look up recipes for chocolate cake',
      ],
      execute: async (input: { query: string; limit?: number }, env: Env) => {
        try {
          // In a real implementation, this would call a search API
          // For Phase 3, we'll return mock data
          return mockWebSearchResults(input.query, input.limit || 5);
        } catch (error) {
          return {
            error: `Failed to search web: ${
              error instanceof Error ? error.message : String(error)
            }`,
            query: input.query,
          };
        }
      },
    });

    // Register calendar tool
    ToolRegistry.registerTool({
      name: 'calendar',
      description: 'Retrieves calendar events for the user',
      category: ToolCategory.EXTERNAL_DATA,
      requiresAuth: true,
      parameters: [
        {
          name: 'startDate',
          type: 'string',
          description: 'Start date in ISO format (YYYY-MM-DD)',
          required: false,
        },
        {
          name: 'endDate',
          type: 'string',
          description: 'End date in ISO format (YYYY-MM-DD)',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximum number of events to return',
          required: false,
          default: 5,
        },
      ],
      examples: [
        'Check my calendar for today',
        'Show my meetings for next week',
        'What events do I have scheduled for tomorrow?',
      ],
      execute: async (
        input: { startDate?: string; endDate?: string; limit?: number },
        env: Env,
      ) => {
        try {
          // In a real implementation, this would call a calendar API
          // For Phase 3, we'll return mock data
          return mockCalendarEvents(input.startDate, input.endDate, input.limit || 5);
        } catch (error) {
          return {
            error: `Failed to get calendar events: ${
              error instanceof Error ? error.message : String(error)
            }`,
            dateRange: `${input.startDate || 'today'} to ${input.endDate || 'today'}`,
          };
        }
      },
    });

    logger.info('Default tools registered successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to register default tools');
    throw error;
  }
}

/**
 * Sanitize a math expression to prevent code injection
 * @param expression Math expression to sanitize
 * @returns Sanitized expression
 */
function sanitizeMathExpression(expression: string): string {
  // Remove all characters except numbers, basic operators, parentheses, and decimal points
  return (
    expression
      .replace(/[^0-9+\-*/().%\s]/g, '')
      // Prevent multiple operators in a row
      .replace(/[+\-*/%]{2,}/g, match => match[0])
  );
}

/**
 * Generate mock weather data
 * @param location Location to get weather for
 * @param units Units to use (metric, imperial, or standard)
 * @returns Mock weather data
 */
function mockWeatherData(location: string, units: string): any {
  const tempUnit = units === 'imperial' ? '°F' : '°C';
  const temp =
    units === 'imperial'
      ? Math.round(Math.random() * 50 + 30) // 30-80°F
      : Math.round(Math.random() * 25 + 5); // 5-30°C

  const conditions = [
    'Sunny',
    'Partly Cloudy',
    'Cloudy',
    'Rainy',
    'Thunderstorms',
    'Snowy',
    'Foggy',
  ];
  const condition = conditions[Math.floor(Math.random() * conditions.length)];

  return {
    location,
    temperature: `${temp}${tempUnit}`,
    condition,
    humidity: `${Math.round(Math.random() * 60 + 30)}%`, // 30-90%
    windSpeed: `${Math.round(Math.random() * 20 + 5)} ${units === 'imperial' ? 'mph' : 'km/h'}`,
    forecast: `The weather in ${location} is currently ${condition.toLowerCase()} with a temperature of ${temp}${tempUnit}.`,
  };
}

/**
 * Generate mock web search results
 * @param query Search query
 * @param limit Maximum number of results to return
 * @returns Mock search results
 */
function mockWebSearchResults(query: string, limit: number): any {
  const results = [];

  for (let i = 0; i < limit; i++) {
    results.push({
      title: `Result ${i + 1} for "${query}"`,
      url: `https://example.com/result-${i + 1}`,
      snippet: `This is a mock search result for "${query}". It contains some information that might be relevant to your query.`,
    });
  }

  return {
    query,
    resultCount: limit,
    results,
  };
}

/**
 * Generate mock calendar events
 * @param startDate Start date in ISO format
 * @param endDate End date in ISO format
 * @param limit Maximum number of events to return
 * @returns Mock calendar events
 */
function mockCalendarEvents(startDate?: string, endDate?: string, limit: number = 5): any {
  const events = [];
  const start = startDate ? new Date(startDate) : new Date();
  const end = endDate ? new Date(endDate) : new Date(start);
  end.setDate(end.getDate() + 1); // Default to one day if no end date

  const eventTypes = ['Meeting', 'Call', 'Appointment', 'Reminder', 'Deadline'];

  for (let i = 0; i < limit; i++) {
    const eventDate = new Date(start);
    eventDate.setHours(9 + Math.floor(Math.random() * 8)); // Between 9 AM and 5 PM
    eventDate.setMinutes(Math.random() < 0.5 ? 0 : 30); // On the hour or half hour

    const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];

    events.push({
      id: `event-${i + 1}`,
      title: `${eventType} ${i + 1}`,
      start: eventDate.toISOString(),
      duration: 30 + Math.floor(Math.random() * 4) * 15, // 30, 45, 60, 75, or 90 minutes
      location: Math.random() < 0.5 ? 'Virtual' : 'Office',
    });
  }

  return {
    startDate: start.toISOString().split('T')[0],
    endDate: end.toISOString().split('T')[0],
    eventCount: events.length,
    events,
  };
}

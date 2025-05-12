import { Bindings } from '../types';
import { ServiceError, logError } from '@dome/common'; // Added logError

/**
 * Content type enum
 */
export enum ContentType {
  NOTE = 'note',
  TASK = 'task',
  REMINDER = 'reminder',
  FILE = 'file',
}

/**
 * Entity type enum
 */
export enum EntityType {
  DATE = 'date',
  TAG = 'tag',
  PERSON = 'person',
  LOCATION = 'location',
  ORGANIZATION = 'organization',
  URL = 'url',
  EMAIL = 'email',
}

/**
 * Entity interface
 */
export interface Entity {
  type: EntityType;
  value: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Extracted content interface
 */
export interface ExtractedContent {
  contentType: ContentType;
  title?: string;
  body: string;
  entities: Entity[];
  dueDate?: number;
  priority?: string;
  reminderTime?: number;
}

/**
 * NLP Processor class for natural language input processing
 */
export class NlpProcessor {
  /**
   * Process natural language input
   * @param env Environment bindings
   * @param input User input
   * @returns Promise<ExtractedContent>
   */
  async processInput(env: Bindings, input: string): Promise<ExtractedContent> {
    try {
      // Check if AI binding is available
      if (!env.AI) {
        // Fallback to rule-based processing if AI is not available
        return this.processInputWithRules(input);
      }

      // Process with Workers AI
      return this.processInputWithAI(env, input);
    } catch (error) {
      logError(error, 'Error processing natural language input');

      // Fallback to rule-based processing on error
      try {
        return this.processInputWithRules(input);
      } catch (fallbackError) {
        throw new ServiceError('Failed to process natural language input', {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  /**
   * Process input with Workers AI
   * @param env Environment bindings
   * @param input User input
   * @returns Promise<ExtractedContent>
   */
  private async processInputWithAI(env: Bindings, input: string): Promise<ExtractedContent> {
    try {
      // Prepare prompt for content classification and entity extraction
      const prompt = `
        Analyze the following text and extract structured information:
        
        Text: "${input.replace(/"/g, '\\"')}"
        
        Return a JSON object with the following structure:
        {
          "contentType": "note" | "task" | "reminder" | "file",
          "title": "extracted or generated title",
          "body": "the main content",
          "entities": [
            {
              "type": "date" | "tag" | "person" | "location" | "organization" | "url" | "email",
              "value": "extracted value",
              "startIndex": start position in text,
              "endIndex": end position in text
            }
          ],
          "dueDate": timestamp in milliseconds (if task or reminder),
          "priority": "low" | "medium" | "high" | "urgent" (if task),
          "reminderTime": timestamp in milliseconds (if reminder)
        }
      `;

      // Call Workers AI (we've already checked that env.AI exists in the calling method)
      const ai = env.AI!; // Use non-null assertion since we've checked this in processInput
      const result = await ai.run('@cf/meta/llama-3-8b-instruct', {
        prompt,
      });

      // Parse the response
      let parsedResult: ExtractedContent;
      try {
        // Extract JSON from the response
        const jsonMatch = result.response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in AI response');
        }

        const jsonStr = jsonMatch[0];
        parsedResult = JSON.parse(jsonStr);
      } catch (parseError) {
        logError(parseError, 'Error parsing AI response');
        // Fallback to rule-based processing
        return this.processInputWithRules(input);
      }

      // Validate and return the result
      return {
        contentType: this.validateContentType(parsedResult.contentType),
        title: parsedResult.title,
        body: parsedResult.body || input,
        entities: Array.isArray(parsedResult.entities) ? parsedResult.entities : [],
        dueDate: parsedResult.dueDate,
        priority: parsedResult.priority,
        reminderTime: parsedResult.reminderTime,
      };
    } catch (error) {
      logError(error, 'Error processing input with AI');
      throw error;
    }
  }

  /**
   * Process input with rule-based approach (fallback)
   * @param input User input
   * @returns ExtractedContent
   */
  private processInputWithRules(input: string): ExtractedContent {
    // Default to note content type
    let contentType = ContentType.NOTE;

    // Extract entities
    const entities: Entity[] = [];

    // Check for task indicators
    const taskIndicators = [
      'todo',
      'to-do',
      'to do',
      'task',
      'complete',
      'finish',
      'accomplish',
      'by tomorrow',
      'by next week',
      'by monday',
      'by tuesday',
      'by wednesday',
      'by thursday',
      'by friday',
      'by saturday',
      'by sunday',
    ];

    if (taskIndicators.some(indicator => input.toLowerCase().includes(indicator))) {
      contentType = ContentType.TASK;
    }

    // Check for reminder indicators
    const reminderIndicators = [
      'remind',
      'reminder',
      'remember',
      "don't forget",
      'alert',
      'at 10am',
      'at 11am',
      'at 12pm',
      'at 1pm',
      'at 2pm',
      'at 3pm',
      'at 4pm',
      'at 5pm',
      'at 6pm',
      'at 7pm',
      'at 8pm',
      'at 9pm',
    ];

    if (reminderIndicators.some(indicator => input.toLowerCase().includes(indicator))) {
      contentType = ContentType.REMINDER;
    }

    // Check for file indicators
    const fileIndicators = [
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.txt',
      '.csv',
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      'http://',
      'https://',
    ];

    if (fileIndicators.some(indicator => input.includes(indicator))) {
      contentType = ContentType.FILE;
    }

    // Extract tags (words starting with #)
    const tagRegex = /#(\w+)/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(input)) !== null) {
      entities.push({
        type: EntityType.TAG,
        value: tagMatch[1],
        startIndex: tagMatch.index,
        endIndex: tagMatch.index + tagMatch[0].length,
      });
    }

    // Extract dates (simple patterns)
    const datePatterns = [
      // MM/DD/YYYY
      { regex: /(\d{1,2})\/(\d{1,2})\/(\d{4})/g, format: 'MM/DD/YYYY' },
      // YYYY-MM-DD
      { regex: /(\d{4})-(\d{1,2})-(\d{1,2})/g, format: 'YYYY-MM-DD' },
      // Month DD, YYYY
      {
        regex:
          /(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})/gi,
        format: 'Month DD, YYYY',
      },
    ];

    for (const pattern of datePatterns) {
      let dateMatch;
      while ((dateMatch = pattern.regex.exec(input)) !== null) {
        entities.push({
          type: EntityType.DATE,
          value: dateMatch[0],
          startIndex: dateMatch.index,
          endIndex: dateMatch.index + dateMatch[0].length,
        });
      }
    }

    // Extract emails
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
    let emailMatch;
    while ((emailMatch = emailRegex.exec(input)) !== null) {
      entities.push({
        type: EntityType.EMAIL,
        value: emailMatch[0],
        startIndex: emailMatch.index,
        endIndex: emailMatch.index + emailMatch[0].length,
      });
    }

    // Extract URLs
    const urlRegex = /https?:\/\/[^\s]+/g;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(input)) !== null) {
      entities.push({
        type: EntityType.URL,
        value: urlMatch[0],
        startIndex: urlMatch.index,
        endIndex: urlMatch.index + urlMatch[0].length,
      });
    }

    // Generate a title from the first line or first few words
    const firstLine = input.split('\n')[0].trim();
    const title = firstLine.length <= 50 ? firstLine : firstLine.substring(0, 47) + '...';

    // Estimate due date for tasks (if applicable)
    let dueDate: number | undefined;
    let reminderTime: number | undefined;

    if (contentType === ContentType.TASK || contentType === ContentType.REMINDER) {
      // Look for date entities
      const dateEntity = entities.find(e => e.type === EntityType.DATE);
      if (dateEntity) {
        // Simple parsing for demonstration purposes
        // In a real implementation, use a proper date parsing library
        try {
          const dateValue = dateEntity.value;
          const date = new Date(dateValue);
          if (!isNaN(date.getTime())) {
            dueDate = date.getTime();

            // For reminders, set reminder time to the same as due date
            if (contentType === ContentType.REMINDER) {
              reminderTime = dueDate;
            }
          }
        } catch (e) {
          console.warn('Error parsing date:', e);
        }
      }
    }

    // Determine priority for tasks
    let priority: string | undefined;
    if (contentType === ContentType.TASK) {
      if (input.toLowerCase().includes('urgent') || input.toLowerCase().includes('asap')) {
        priority = 'urgent';
      } else if (
        input.toLowerCase().includes('high priority') ||
        input.toLowerCase().includes('important')
      ) {
        priority = 'high';
      } else if (
        input.toLowerCase().includes('low priority') ||
        input.toLowerCase().includes('whenever')
      ) {
        priority = 'low';
      } else {
        priority = 'medium';
      }
    }

    return {
      contentType,
      title,
      body: input,
      entities,
      dueDate,
      priority,
      reminderTime,
    };
  }

  /**
   * Validate content type
   * @param contentType Content type string
   * @returns ContentType
   */
  private validateContentType(contentType: string): ContentType {
    switch (contentType.toLowerCase()) {
      case 'note':
        return ContentType.NOTE;
      case 'task':
        return ContentType.TASK;
      case 'reminder':
        return ContentType.REMINDER;
      case 'file':
        return ContentType.FILE;
      default:
        return ContentType.NOTE;
    }
  }
}

// Export singleton instance
export const nlpProcessor = new NlpProcessor();

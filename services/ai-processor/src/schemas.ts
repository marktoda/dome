import { z } from 'zod';

/**
 * Base schema for common fields across all content types
 */
export const BaseContentSchema = z.object({
  title: z.string().min(1).max(100),
  summary: z.string().min(1).max(500),
  topics: z.array(z.string()).optional(),
});

/**
 * Schema for note content type
 */
export const NoteProcessingSchema = BaseContentSchema.extend({
  todos: z
    .array(
      z.object({
        text: z.string(),
        dueDate: z.string().optional(),
        priority: z.enum(['high', 'medium', 'low']).default('medium'),
      }),
    )
    .default([]),
  reminders: z
    .array(
      z.object({
        text: z.string(),
        reminderTime: z.string().optional(),
      }),
    )
    .default([]),
  topics: z.array(z.string()).default([]),
});

/**
 * Schema for code content type
 */
export const CodeProcessingSchema = BaseContentSchema.extend({
  todos: z
    .array(
      z.object({
        text: z.string(),
        location: z.string().optional(),
      }),
    )
    .default([]),
  components: z.array(z.string()).default([]),
  language: z.string().default('unknown'),
  frameworks: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
});

/**
 * Schema for article content type
 */
export const ArticleProcessingSchema = BaseContentSchema.extend({
  keyPoints: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  entities: z
    .object({
      people: z.array(z.string()).default([]),
      organizations: z.array(z.string()).default([]),
      products: z.array(z.string()).default([]),
    })
    .default({ people: [], organizations: [], products: [] }),
});

/**
 * Schema for default/unknown content type
 */
export const DefaultProcessingSchema = BaseContentSchema.extend({
  topics: z.array(z.string()).default([]),
});

/**
 * Type definitions for the schema results
 */
export type NoteProcessingResult = z.infer<typeof NoteProcessingSchema>;
export type CodeProcessingResult = z.infer<typeof CodeProcessingSchema>;
export type ArticleProcessingResult = z.infer<typeof ArticleProcessingSchema>;
export type DefaultProcessingResult = z.infer<typeof DefaultProcessingSchema>;

/**
 * Get the appropriate schema based on content type
 */
export function getSchemaForContentType(contentType: string): z.ZodSchema {
  switch (contentType) {
    case 'note':
      return NoteProcessingSchema;
    case 'code':
      return CodeProcessingSchema;
    case 'article':
      return ArticleProcessingSchema;
    default:
      return DefaultProcessingSchema;
  }
}

/**
 * Schema instructions to provide to the LLM
 */
export function getSchemaInstructions(contentType: string): string {
  // Common instructions for all content types
  const baseInstructions = `
Format your response as a properly structured JSON object.
Do not include any explanations, only the JSON result.
`;

  // Content-type specific instructions
  switch (contentType) {
    case 'note':
      return `${baseInstructions}
The JSON should have these fields:
- title: A concise title (5-7 words max)
- summary: A concise summary (2-3 sentences max)
- todos: Array of todo items, each with "text", optional "dueDate", and "priority" (high/medium/low)
- reminders: Array of reminder items, each with "text" and optional "reminderTime"
- topics: Array of relevant topics or categories

Example structure:
{
  "title": "Project Planning Meeting Notes",
  "summary": "Notes from the weekly project planning meeting discussing timelines and resource allocation.",
  "todos": [
    {"text": "Update project timeline", "dueDate": "2025-05-10", "priority": "high"},
    {"text": "Allocate resources for Q3", "priority": "medium"}
  ],
  "reminders": [
    {"text": "Send meeting summary", "reminderTime": "2025-05-03T15:00:00Z"}
  ],
  "topics": ["Project Management", "Planning", "Resources"]
}`;

    case 'code':
      return `${baseInstructions}
The JSON should have these fields:
- title: A concise title describing what this code does (5-7 words)
- summary: A concise description (2-3 sentences)
- todos: Array of TODO comments found in the code, each with "text" and optional "location"
- components: Array of key functions/classes/components
- language: Programming language used
- frameworks: Array of frameworks used
- topics: Array of relevant topics

Example structure:
{
  "title": "User Authentication API Handler",
  "summary": "Handles user authentication API endpoints including login, logout, and token refresh.",
  "todos": [
    {"text": "Add rate limiting", "location": "login function"}
  ],
  "components": ["loginHandler", "validateToken", "refreshTokenGenerator"],
  "language": "TypeScript",
  "frameworks": ["Express", "JWT"],
  "topics": ["Authentication", "API", "Security"]
}`;

    case 'article':
      return `${baseInstructions}
The JSON should have these fields:
- title: A concise title (5-7 words)
- summary: A concise summary (3-5 sentences)
- keyPoints: Array of key points or takeaways
- topics: Array of main topics or categories
- entities: Object with "people", "organizations", and "products" arrays

Example structure:
{
  "title": "AI Advances in Healthcare",
  "summary": "Recent AI developments are transforming healthcare diagnostics and treatment planning.",
  "keyPoints": ["AI improves diagnostic accuracy", "Reduces treatment planning time"],
  "topics": ["Healthcare", "Artificial Intelligence", "Technology"],
  "entities": {
    "people": ["Dr. Jane Smith", "John Davis"],
    "organizations": ["HealthTech Inc", "National Health Institute"],
    "products": ["DiagnosticAI", "MedAssist"]
  }
}`;

    default:
      return `${baseInstructions}
The JSON should have these fields:
- title: A concise title (5-7 words max)
- summary: A concise summary (2-3 sentences max)
- topics: Array of relevant topics or categories

Example structure:
{
  "title": "Quarterly Financial Report",
  "summary": "Overview of Q2 financial performance including revenue growth and expense management.",
  "topics": ["Finance", "Reporting", "Business"]
}`;
  }
}

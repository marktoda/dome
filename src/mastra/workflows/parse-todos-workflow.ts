import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { aiGenerateObject } from '../services/AIService.js';
import { prompts } from '../prompts/PromptRegistry.js';

// Schema for a parsed TODO item
const TodoItemSchema = z.object({
  text: z.string(),
  status: z.enum(['pending', 'in-progress', 'done']),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  tags: z.array(z.string()).optional(),
  dueDate: z.string().optional(),
});

// Input schema - file content to parse
const ParseTodosInputSchema = z.object({
  content: z.string(),
  filePath: z.string(),
});

// Output schema - structured todos
const ParseTodosOutputSchema = z.object({
  todos: z.array(TodoItemSchema),
  totalFound: z.number(),
  reasoning: z.string(),
});

// Single step workflow for parsing todos
const parseTodosStep = createStep({
  id: 'parse-todos',
  description: 'Use LLM to extract and structure TODO items from text content',
  inputSchema: ParseTodosInputSchema,
  outputSchema: ParseTodosOutputSchema,
  execute: async (context: any) => {
    const { inputData: input } = context;
    const { content, filePath } = input;

    // Use centralized prompt with file context
    const fullPrompt = `${prompts.extractTodos(content)}

File: ${filePath}

Look for:
1. Explicit TODO markers (TODO:, FIXME:, HACK:, NOTE:, XXX:)
2. Markdown checkboxes (- [ ], - [x], - [/])
3. Action items in natural language (e.g., "need to fix", "should implement")
4. Future work mentioned (e.g., "will need to", "later we should")
5. Questions that imply actions
6. Comments indicating incomplete work

For each TODO:
- Extract the core task description
- Determine status: pending ([ ], TODO), in-progress ([/], WIP), done ([x], DONE)
- Assign priority based on language: high (urgent/critical), medium (should/need), low (could/maybe)
- Extract any tags or categories
- Look for due dates or time references

Be comprehensive but avoid duplicates. Focus on actionable items.`;

    try {
      const result = await aiGenerateObject(
        fullPrompt,
        ParseTodosOutputSchema
      );

      return {
        todos: result.todos,
        totalFound: result.todos.length,
        reasoning: result.reasoning,
      };
    } catch (error) {
      console.error('Error parsing todos:', error);
      return {
        todos: [],
        totalFound: 0,
        reasoning: 'Failed to parse todos due to an error',
      };
    }
  },
});

// Create the workflow
export const parseTodosWorkflow = createWorkflow({
  id: 'parse-todos-workflow',
  description: 'Extract and structure TODO items from text content using AI',
  inputSchema: ParseTodosInputSchema,
  outputSchema: ParseTodosOutputSchema,
})
  .then(parseTodosStep)
  .commit();
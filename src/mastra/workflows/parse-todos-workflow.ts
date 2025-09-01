import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { generateObject } from 'ai';

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

    const prompt = `You are a TODO extraction assistant. Analyze the following text content and extract all TODO items, action items, and tasks mentioned.

Look for:
1. Explicit TODO markers (TODO:, FIXME:, HACK:, NOTE:, XXX:)
2. Markdown checkboxes (- [ ], - [x], - [/])
3. Action items in natural language (e.g., "need to fix", "should implement", "must add", "remember to")
4. Future work mentioned (e.g., "will need to", "later we should", "eventually")
5. Questions that imply actions (e.g., "How do we handle...?", "What about...?")
6. Comments indicating incomplete work
7. Numbered or bulleted lists that describe tasks

For each TODO item found:
- Extract the core task description
- Determine status: 
  - 'pending' for uncompleted tasks ([ ], TODO, etc.)
  - 'in-progress' for partially done ([/], WIP, etc.) 
  - 'done' for completed ([x], DONE, etc.)
- Assign priority based on language cues:
  - 'high' for urgent/critical/must/asap
  - 'medium' for should/need/important
  - 'low' for could/maybe/nice-to-have
- Extract any tags or categories mentioned
- Look for due dates or time references

Be comprehensive but avoid duplicates. Focus on actionable items, not general observations.

File: ${filePath}
Content:
${content}`;

    try {
      const response = await generateObject({
        model: openai('gpt-4o-mini'),
        schema: ParseTodosOutputSchema,
        prompt,
      });

      const result = response.object;

      return {
        todos: result.todos,
        totalFound: result.todos.length,
        reasoning: result.reasoning,
      };
    } catch (error) {
      console.error('Failed to parse todos:', error);
      return {
        todos: [],
        totalFound: 0,
        reasoning: `Error parsing todos: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
});

// Create and export the workflow
export const parseTodosWorkflow = createWorkflow({
  id: 'parse-todos',
  description: 'Extract and structure TODO items from file content using LLM',
  inputSchema: ParseTodosInputSchema,
  outputSchema: ParseTodosOutputSchema,
})
  .then(parseTodosStep)
  .commit();
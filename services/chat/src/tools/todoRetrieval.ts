import { z } from 'zod';
import { getLogger } from '@dome/common';
import { Document } from '../types';
import { RetrievalTool, RetrievalInput } from '.';
import { createTodosClient, TodosWorkerBinding, TodoStatus, TodoPriority, TodoItem, TodoFilter } from '@dome/todos/client';

/* ------------------------------------------------------------------ */
/* Schemas                                                            */
/* ------------------------------------------------------------------ */
export const todoRetrievalInput = z.object({
  /** User ID to fetch todos for */
  userId: z.string(),
  /** Filter by todo status */
  status: z.nativeEnum(TodoStatus).or(z.array(z.nativeEnum(TodoStatus))).optional(),
  /** Filter by todo priority */
  priority: z.nativeEnum(TodoPriority).or(z.array(z.nativeEnum(TodoPriority))).optional(),
  /** Filter by category */
  category: z.string().optional(),
  /** Filter by due date (before) */
  dueBefore: z.number().optional(),
  /** Filter by due date (after) */
  dueAfter: z.number().optional(),
  /** Maximum number of items to return (default: 10) */
  limit: z.number().int().min(1).max(50).optional(),
});

const DEFAULT_LIMIT = 10;

export const todoRetrievalOutput = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      status: z.nativeEnum(TodoStatus),
      priority: z.nativeEnum(TodoPriority),
      category: z.string().optional(),
      tags: z.string().optional(),
      dueDate: z.number().optional(),
      completedAt: z.number().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
      estimatedEffort: z.string().optional(),
      actionableSteps: z.string().optional(),
    })
  ),
  totalCount: z.number().optional(),
});

type ParsedTodoRetrievalInput = z.infer<typeof todoRetrievalInput>;
type TodoRetrievalOutput = z.infer<typeof todoRetrievalOutput>;

/* ------------------------------------------------------------------ */
/* Tool implementation                                                */
/* ------------------------------------------------------------------ */
export const todoRetrievalTool: RetrievalTool<
  ParsedTodoRetrievalInput,
  TodoRetrievalOutput,
  ParsedTodoRetrievalInput
> = {
  name: 'todo_retrieval',
  description: 'Retrieves the user\'s todo list with filtering options. Always use in conjunction with user notes',

  inputSchema: todoRetrievalInput,
  outputSchema: todoRetrievalOutput,

  async retrieve(input: RetrievalInput, env: Env): Promise<TodoRetrievalOutput> {
    return this.execute(
      {
        limit: DEFAULT_LIMIT,
        ...input,
      },
      env,
    );
  },

  async execute(input, env: Env): Promise<TodoRetrievalOutput> {
    const logger = getLogger();

    // Create a TodosClient using the binding from the environment
    if (!env.TODOS) {
      logger.error('TODOS binding is missing from environment');
      return { items: [] };
    }

    const todosClient = createTodosClient(env.TODOS as unknown as TodosWorkerBinding);

    // Build the filter from the input
    const filter: TodoFilter = {
      userId: input.userId,
      status: input.status,
      priority: input.priority,
      category: input.category,
      dueBefore: input.dueBefore,
      dueAfter: input.dueAfter,
    };

    // Set up pagination
    const pagination = {
      limit: input.limit || DEFAULT_LIMIT,
    };

    logger.info({ filter, pagination }, '[TodoRetrievalTool]: Fetching todos');

    try {
      // Fetch todos from the Todos service
      const result = await todosClient.listTodos(filter, pagination);

      // Convert to the expected output format
      return {
        items: result.items.map((item: TodoItem) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          status: item.status,
          priority: item.priority,
          category: item.category,
          tags: item.tags,
          dueDate: item.dueDate,
          completedAt: item.completedAt,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          estimatedEffort: item.estimatedEffort,
          actionableSteps: item.actionableSteps,
        })),
        totalCount: result.totalCount,
      };
    } catch (error) {
      logger.error({ error }, '[TodoRetrievalTool]: Error fetching todos');
      throw error;
    }
  },

  toDocuments(input: TodoRetrievalOutput): Document[] {
    return input.items.map(item => {
      // Format the todo item as a document
      const dueDate = item.dueDate ? new Date(item.dueDate).toLocaleString() : 'No due date';
      const tagsString = item.tags ? `Tags: ${item.tags}` : '';
      const category = item.category ? `Category: ${item.category}` : '';
      const effort = item.estimatedEffort ? `Estimated effort: ${item.estimatedEffort}` : '';
      const steps = item.actionableSteps ? `Steps: ${item.actionableSteps}` : '';

      // Format the content for better readability
      const content = `
Title: ${item.title}
${item.description ? `Description: ${item.description}` : ''}
Status: ${item.status}
Priority: ${item.priority}
${dueDate}
${effort}
${category}
${tagsString}
${steps}
`.trim();

      return {
        id: item.id,
        content,
        title: item.title,
        metadata: {
          source: 'todo',
          sourceType: 'todo',
          createdAt: new Date(item.createdAt).toISOString(),
          updatedAt: new Date(item.updatedAt).toISOString(),
          dueDate: item.dueDate ? new Date(item.dueDate).toISOString() : undefined,
          status: item.status,
          priority: item.priority,
          relevanceScore: 1.0,
        },
      };
    });
  },

  examples: [
    {
      input: {
        userId: 'test-user',
        status: TodoStatus.PENDING,
        priority: TodoPriority.HIGH,
        limit: 5
      },
      output: {
        items: [
          {
            id: 'todo-1',
            title: 'Complete project proposal',
            description: 'Finish the draft and send for review',
            status: TodoStatus.PENDING,
            priority: TodoPriority.HIGH,
            category: 'Work',
            dueDate: Date.now() + 86400000, // tomorrow
            createdAt: Date.now(),
            updatedAt: Date.now(),
            estimatedEffort: '2 hours',
          }
        ],
        totalCount: 1
      },
      description: 'Shows high priority pending tasks with upcoming deadlines',
    },
  ],
};

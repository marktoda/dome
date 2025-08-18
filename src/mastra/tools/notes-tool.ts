import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { NoteId, NoteService } from '../../core/services/NoteService.js';
import { NoteSearchService } from '../../core/services/NoteSearchService.js';
import { trackActivity } from '../../cli/chat/utils/activityTracker.js';
import { toRel } from '../../core/utils/path-utils.js';
import { FolderContextService } from '../../core/services/FolderContextService.js';
import { createEventBus } from '../../core/events/index.js';

interface NotesTools {
  vaultContextTool: any;
  getNoteTool: any;
  writeNoteTool: any;
  removeNoteTool: any;
  searchNotesTool: any;
}

export function getNotesTools(): NotesTools {
  const contextService = new FolderContextService();
  const noteService = new NoteService(createEventBus({
    enableVectorEmbed: true,
    enableTodoExtraction: true
  }));
  const noteSearchService = new NoteSearchService(noteService);

  return {
    vaultContextTool: createTool({
      id: 'getVaultContext',
      description: 'List all note metadata and context from the local vault',
      inputSchema: z.object({}),
      outputSchema: z.object({
        notes: z.array(
          z.object({
            title: z.string(),
            date: z.string(),
            tags: z.array(z.string()),
            path: z.string(),
          })
        ),
        context: z.string().nullable(),
      }),
      execute: async () => {
        const notes = await noteService.listNotes();
        return {
          notes,
          context: await contextService.getIndex(),
        };
      },
    }),
    getNoteTool: createTool({
      id: 'getNote',
      description: 'Get a specific note by path from the local vault',
      inputSchema: z.object({
        path: z.string().describe("Note file path (e.g., 'inbox/my-note.md')"),
      }),
      outputSchema: z.union([
        z.object({
          path: z.string(),
          title: z.string(),
          date: z.string(),
          tags: z.array(z.string()),
          body: z.string(),
          fullPath: z.string(),
        }),
        z.null(),
      ]),
      execute: async ({ context }) => {
        // Track note access for the Chat TUI sidebar
        trackActivity('document', context.path);
        return noteService.getNote(toRel(context.path) as NoteId);
      },
    }),
    writeNoteTool: createTool({
      id: 'writeNote',
      description: 'Create a new note or overwrite an existing note.',
      inputSchema: z.object({
        path: z
          .string()
          .describe("Note path like 'meetings/weekly-standup.md' or 'inbox/ideas.md'"),
        content: z.string().describe('The markdown content to write or append'),
        title: z
          .string()
          .optional()
          .describe('Title for the note (only used when creating new notes)'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tags for the note (only used when creating)'),
      }),
      outputSchema: z.object({
        type: z.enum(['created', 'updated']),
        oldContent: z.string().optional(),
      }),
      execute: async ({ context }) => {
        return noteService.writeNote(toRel(context.path) as NoteId, context.content);
      },
    }),
    removeNoteTool: createTool({
      id: 'removeNote',
      description:
        'Remove/delete a note from the vault. Use this to clean up unused, empty, or low-quality notes.',
      inputSchema: z.object({
        path: z.string().describe("Note path to remove (e.g., 'inbox/draft.md')"),
      }),
      outputSchema: z.object({
        removedContent: z.string(),
      }),
      execute: async ({ context }) => {
        return noteService.removeNote(toRel(context.path) as NoteId);
      },
    }),
    searchNotesTool: createTool({
      id: 'searchNotes',
      description:
        'Search notes using semantic similarity based on meaning, not just exact keywords',
      inputSchema: z.object({
        query: z.string().describe('Natural language query to search for in notes'),
        k: z.number().optional().default(6).describe('Number of top results to return'),
      }),
      outputSchema: z.array(
        z.object({
          notePath: z.string(),
          score: z.number(),
          excerpt: z.string(),
          tags: z.array(z.string()).optional(),
        })
      ),
      execute: async ({ context }) => {
        try {
          const results = await noteSearchService.searchNotes(context.query);

          // Ensure results is an array and handle potential undefined values
          if (!Array.isArray(results)) {
            console.error('Search returned non-array result:', results);
            return [];
          }

          // Transform results to match expected output schema
          return results.map(result => ({
            notePath: result.metadata?.notePath || '',
            score: result.score || 0,
            excerpt: result.metadata?.text || '',
            tags: Array.isArray(result.metadata?.tags) ? result.metadata.tags : [],
          }));
        } catch (error) {
          console.error('Error searching notes:', error instanceof Error ? error.message : error);
          // Return empty array instead of throwing to allow agent to fall back
          return [];
        }
      },
    }),
  };
}

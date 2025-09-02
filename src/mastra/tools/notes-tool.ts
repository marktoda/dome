import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { NoteId, NoteService } from '../../core/services/NoteService.js';
import { NoteSearchService } from '../../core/services/NoteSearchService.js';
import { trackActivity } from '../../cli/chat/utils/activityTracker.js';
import { toRel } from '../../core/utils/path-utils.js';
import { FolderContextService } from '../../core/services/FolderContextService.js';
import { debugLogger } from '../../cli/chat/utils/debugLogger.js';

export function getNotesTools() {
  const contextService = new FolderContextService();
  const noteService = new NoteService();
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
        debugLogger.debug('vaultContextTool called', 'AI-Tool');
        try {
          const notes = await noteService.listNotes();
          const context = await contextService.getIndex();
          debugLogger.debug(`Found ${notes.length} notes in vault`, 'AI-Tool');
          return {
            notes,
            context,
          };
        } catch (error) {
          debugLogger.error(`vaultContextTool error: ${error}`, 'AI-Tool');
          throw error;
        }
      },
    }),
    getNoteTool: createTool({
      id: 'getNote',
      description: 'Get a specific note by path from the local vault',
      inputSchema: z.object({
        path: z.string().describe("Note file path (e.g., 'inbox/my-note.md')"),
      }),
      outputSchema: z.object({
        found: z.boolean(),
        path: z.string().optional(),
        title: z.string().optional(),
        date: z.string().optional(),
        tags: z.array(z.string()).optional(),
        body: z.string().optional(),
        fullPath: z.string().optional(),
      }),
      execute: async (executionContext) => {
        const { path } = executionContext.context;
        debugLogger.debug(`getNoteTool called for: ${path}`, 'AI-Tool');
        // Track note access for the Chat TUI sidebar
        trackActivity('document', path);
        const note = await noteService.getNote(toRel(path) as NoteId);
        if (note) {
          debugLogger.debug(`Successfully retrieved note: ${path}`, 'AI-Tool');
          debugLogger.debug(`Note content length: ${note.body?.length || 0} chars`, 'AI-Tool');
          debugLogger.debug(`Note has body: ${!!note.body}`, 'AI-Tool');
          return {
            found: true,
            ...note
          };
        } else {
          debugLogger.warn(`Note not found: ${path}`, 'AI-Tool');
          return {
            found: false
          };
        }
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
      execute: async (executionContext) => {
        const { path, content, title, tags } = executionContext.context;
        debugLogger.debug(`writeNoteTool called for: ${path}`, 'AI-Tool');
        const result = await noteService.writeNote(toRel(path) as NoteId, content);
        debugLogger.info(`Note written: ${path} (${result.type})`, 'AI-Tool');
        return result;
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
      execute: async (executionContext) => {
        const { path } = executionContext.context;
        debugLogger.debug(`removeNoteTool called for: ${path}`, 'AI-Tool');
        const result = await noteService.removeNote(toRel(path) as NoteId);
        debugLogger.info(`Note removed: ${path}`, 'AI-Tool');
        return result;
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
      execute: async (executionContext) => {
        const { query, k } = executionContext.context;
        debugLogger.debug(`searchNotesTool called with query: "${query}"`, 'AI-Tool');
        try {
          const results = await noteSearchService.searchNotes(query);

          // Ensure results is an array and handle potential undefined values
          if (!Array.isArray(results)) {
            console.error('Search returned non-array result:', results);
            return [];
          }

          // Transform results to match expected output schema
          const transformed = results.map(result => ({
            notePath: result.metadata?.notePath || '',
            score: result.score || 0,
            excerpt: result.metadata?.text || '',
            tags: Array.isArray(result.metadata?.tags) ? result.metadata.tags : [],
          }));
          debugLogger.debug(`Search returned ${transformed.length} results`, 'AI-Tool');
          return transformed;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          debugLogger.error(`Error searching notes: ${errMsg}`, 'AI-Tool');
          console.error('Error searching notes:', errMsg);
          // Return empty array instead of throwing to allow agent to fall back
          return [];
        }
      },
    }),
  };
}

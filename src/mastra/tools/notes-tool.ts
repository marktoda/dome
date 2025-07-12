import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { listNotes, getNote, writeNote, removeNote, type NoteMeta, type Note } from "../core/notes.js";

export const listNotesTool = createTool({
  id: "listNotes",
  description: "List all note metadata from the local vault",
  inputSchema: z.object({}),
  outputSchema: z.array(z.object({
    title: z.string(),
    date: z.string(),
    tags: z.array(z.string()),
    path: z.string(),
    source: z.enum(["cli", "external"])
  })),
  execute: async () => {
    return listNotes();
  }
});

export const getNoteTool = createTool({
  id: "getNote",
  description: "Get a specific note by path from the local vault",
  inputSchema: z.object({
    path: z.string().describe("Note file path (e.g., 'inbox/my-note.md')")
  }),
  outputSchema: z.union([
    z.object({
      path: z.string(),
      title: z.string(),
      date: z.string(),
      tags: z.array(z.string()),
      source: z.enum(["cli", "external"]),
      body: z.string(),
      fullPath: z.string()
    }),
    z.null()
  ]),
  execute: async ({ context }) => {
    return getNote(context.path);
  }
});

export const writeNoteTool = createTool({
  id: "writeNote",
  description: "Create a new note or append content to an existing note. Always uses auto mode - creates if path doesn't exist, appends if it does.",
  inputSchema: z.object({
    path: z.string().describe("Note path like 'meetings/weekly-standup.md' or 'inbox/ideas.md'"),
    content: z.string().describe("The markdown content to write or append"),
    title: z.string().optional().describe("Title for the note (only used when creating new notes)"),
    tags: z.array(z.string()).optional().describe("Optional tags for the note (only used when creating)")
  }),
  outputSchema: z.object({
    path: z.string(),
    title: z.string(),
    action: z.enum(["created", "appended"]),
    contentLength: z.number(),
    fullPath: z.string()
  }),
  execute: async ({ context }) => {
    return writeNote(context.path, context.content, context.title, context.tags);
  }
});

export const removeNoteTool = createTool({
  id: "removeNote",
  description: "Remove/delete a note from the vault. Use this to clean up unused, empty, or low-quality notes.",
  inputSchema: z.object({
    path: z.string().describe("Note path to remove (e.g., 'inbox/draft.md')")
  }),
  outputSchema: z.object({
    path: z.string(),
    success: z.boolean(),
    message: z.string()
  }),
  execute: async ({ context }) => {
    return removeNote(context.path);
  }
});

// Export search tool
export { searchNotesTool } from "./search-notes-tool.js";

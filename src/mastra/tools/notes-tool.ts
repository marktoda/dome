import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import fg from "fast-glob";
import fs from "node:fs/promises";
import matter from "gray-matter";
import { join, basename, extname, dirname } from "node:path";

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

interface NoteMeta {
  title: string;
  date: string;
  tags: string[];
  path: string;
  source: "cli" | "external";
}

interface Note extends NoteMeta {
  body: string;
  fullPath: string;
}

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

async function listNotes(): Promise<NoteMeta[]> {
  try {
    const paths = await fg("**/*.md", { cwd: vaultPath, dot: false });
    const metas = await Promise.all(paths.map(parseMeta));
    return metas.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch (error) {
    console.error("Error listing notes:", error);
    return [];
  }
}

async function getNote(path: string): Promise<Note | null> {
  try {
    const fullPath = join(vaultPath, path);
    await fs.access(fullPath);
    
    const raw = await fs.readFile(fullPath, "utf8");
    const { data, content } = matter(raw);
    const meta = await deriveMeta(data, fullPath);
    return { ...meta, body: content, fullPath };
  } catch (error) {
    console.error("Error getting note:", error);
    return null;
  }
}

async function parseMeta(relativePath: string): Promise<NoteMeta> {
  const full = join(vaultPath, relativePath);
  try {
    const raw = await fs.readFile(full, "utf8");
    const { data } = matter(raw);
    return deriveMeta(data, full);
  } catch (error) {
    console.error(`Error parsing meta for ${relativePath}:`, error);
    // Return fallback meta
    const stat = await fs.stat(full).catch(() => ({ birthtime: new Date() }));
    const fileName = basename(full, extname(full));
    return {
      title: fileName,
      date: stat.birthtime.toISOString(),
      tags: [],
      path: relativePath,
      source: "external"
    };
  }
}

async function deriveMeta(data: any, fullPath: string): Promise<NoteMeta> {
  const stat = await fs.stat(fullPath).catch(() => ({ birthtime: new Date() }));
  const fileName = basename(fullPath, extname(fullPath));
  const relativePath = fullPath.replace(`${vaultPath}/`, "");
  
  let title = data.title ?? fileName;
  
  // If no title in front-matter, try to extract from first heading
  if (!data.title) {
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const headingMatch = raw.match(/^#\s+(.*)$/m);
      if (headingMatch) {
        title = headingMatch[1];
      }
    } catch (error) {
      // Keep fileName as fallback
    }
  }
  
  return {
    title,
    date: data.date ?? stat.birthtime.toISOString(),
    tags: Array.isArray(data.tags) ? data.tags : [],
    path: relativePath,
    source: data.source ?? "external"
  };
}


async function writeNote(
  path: string,
  content: string,
  title?: string,
  tags: string[] = []
): Promise<{ path: string; title: string; action: "created" | "appended"; contentLength: number; fullPath: string }> {
  try {
    const fullPath = join(vaultPath, path);
    
    // Ensure directory exists
    await fs.mkdir(dirname(fullPath), { recursive: true });

    // Check if note already exists
    const existingNote = await getNote(path);
    
    if (existingNote) {
      // Append to existing note
      const { data: frontMatter, content: currentContent } = matter(await fs.readFile(fullPath, 'utf8'));
      
      // Append new content with proper spacing
      const separator = currentContent.trim() ? '\n\n' : '';
      const updatedContent = currentContent + separator + content;
      
      // Update modified timestamp
      const updatedFrontMatter = {
        ...frontMatter,
        modified: new Date().toISOString()
      };
      
      // Write updated file
      const updatedFileContent = matter.stringify(updatedContent, updatedFrontMatter);
      await fs.writeFile(fullPath, updatedFileContent, 'utf8');
      
      return {
        path,
        title: existingNote.title,
        action: "appended",
        contentLength: content.length,
        fullPath
      };
    } else {
      // Create new note
      const now = new Date();
      const noteTitle = title || basename(path, extname(path));
      
      const frontMatter = {
        title: noteTitle,
        date: now.toISOString(),
        tags,
        source: "cli"
      };
      
      const fileContent = matter.stringify(content, frontMatter);
      await fs.writeFile(fullPath, fileContent, 'utf8');
      
      return {
        path,
        title: noteTitle,
        action: "created",
        contentLength: content.length,
        fullPath
      };
    }
  } catch (error) {
    console.error("Error writing note:", error);
    throw new Error(`Failed to write note: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}


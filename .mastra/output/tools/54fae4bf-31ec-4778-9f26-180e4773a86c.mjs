import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { join, basename, extname } from 'node:path';
import crypto from 'node:crypto';
import { v4 } from 'uuid';

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
const listNotesTool = createTool({
  id: "listNotes",
  description: "List all note metadata from the local vault",
  inputSchema: z.object({}),
  outputSchema: z.array(z.object({
    id: z.string(),
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
const getNoteTool = createTool({
  id: "getNote",
  description: "Get a specific note by ID or path from the local vault",
  inputSchema: z.object({
    idOrPath: z.string().describe("Note ID or file path (e.g., 'inbox/my-note.md')")
  }),
  outputSchema: z.union([
    z.object({
      id: z.string(),
      title: z.string(),
      date: z.string(),
      tags: z.array(z.string()),
      path: z.string(),
      source: z.enum(["cli", "external"]),
      body: z.string()
    }),
    z.null()
  ]),
  execute: async ({ context }) => {
    return getNote(context.idOrPath);
  }
});
const writeNoteTool = createTool({
  id: "writeNote",
  description: "Create a new note or append content to an existing note. Perfect for running meeting notes or iterative content.",
  inputSchema: z.object({
    title: z.string().describe("The title of the note (used for creation or finding existing note)"),
    content: z.string().describe("The markdown content to write or append"),
    mode: z.enum(["create", "append", "auto"]).default("auto").describe("'create' forces new note, 'append' adds to existing, 'auto' creates if not found or appends if found"),
    tags: z.array(z.string()).optional().describe("Optional tags for the note (only used when creating)"),
    folder: z.string().optional().describe("Optional subfolder (e.g., 'inbox', 'meetings')"),
    idOrPath: z.string().optional().describe("Specific note ID or path to append to (overrides title-based lookup)")
  }),
  outputSchema: z.object({
    id: z.string(),
    title: z.string(),
    date: z.string(),
    tags: z.array(z.string()),
    path: z.string(),
    source: z.enum(["cli", "external"]),
    fullPath: z.string(),
    action: z.enum(["created", "appended"]),
    contentLength: z.number()
  }),
  execute: async ({ context }) => {
    return writeNote(
      context.title,
      context.content,
      context.mode,
      context.tags,
      context.folder,
      context.idOrPath
    );
  }
});
async function listNotes() {
  try {
    const paths = await fg("**/*.md", { cwd: vaultPath, dot: false });
    const metas = await Promise.all(paths.map(parseMeta));
    return metas.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch (error) {
    console.error("Error listing notes:", error);
    return [];
  }
}
async function getNote(idOrPath) {
  try {
    const fullPath = await resolvePath(idOrPath);
    if (!fullPath) return null;
    const raw = await fs.readFile(fullPath, "utf8");
    const { data, content } = matter(raw);
    const meta = await deriveMeta(data, fullPath);
    return { ...meta, body: content };
  } catch (error) {
    console.error("Error getting note:", error);
    return null;
  }
}
async function parseMeta(relativePath) {
  const full = join(vaultPath, relativePath);
  try {
    const raw = await fs.readFile(full, "utf8");
    const { data } = matter(raw);
    return deriveMeta(data, full);
  } catch (error) {
    console.error(`Error parsing meta for ${relativePath}:`, error);
    const stat = await fs.stat(full).catch(() => ({ birthtime: /* @__PURE__ */ new Date() }));
    const fileName = basename(full, extname(full));
    return {
      id: crypto.createHash("sha1").update(full).digest("hex"),
      title: fileName,
      date: stat.birthtime.toISOString(),
      tags: [],
      path: relativePath,
      source: "external"
    };
  }
}
async function deriveMeta(data, fullPath) {
  const stat = await fs.stat(fullPath).catch(() => ({ birthtime: /* @__PURE__ */ new Date() }));
  const fileName = basename(fullPath, extname(fullPath));
  const relativePath = fullPath.replace(`${vaultPath}/`, "");
  let title = data.title ?? fileName;
  if (!data.title) {
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const headingMatch = raw.match(/^#\s+(.*)$/m);
      if (headingMatch) {
        title = headingMatch[1];
      }
    } catch (error) {
    }
  }
  return {
    id: data.id ?? crypto.createHash("sha1").update(fullPath).digest("hex"),
    title,
    date: data.date ?? stat.birthtime.toISOString(),
    tags: Array.isArray(data.tags) ? data.tags : [],
    path: relativePath,
    source: data.source ?? "external"
  };
}
async function resolvePath(idOrPath) {
  try {
    if (idOrPath.endsWith(".md")) {
      const fullPath = join(vaultPath, idOrPath);
      await fs.access(fullPath);
      return fullPath;
    }
    const metas = await listNotes();
    const hit = metas.find((m) => m.id === idOrPath);
    return hit ? join(vaultPath, hit.path) : null;
  } catch (error) {
    return null;
  }
}
async function writeNote(title, content, mode = "auto", tags = [], folder, idOrPath) {
  try {
    await fs.mkdir(vaultPath, { recursive: true });
    let existingNote = null;
    let targetPath = null;
    if (mode !== "create") {
      if (idOrPath) {
        existingNote = await getNote(idOrPath);
        targetPath = await resolvePath(idOrPath);
      } else {
        const notes = await listNotes();
        const foundNote = notes.find(
          (n) => n.title.toLowerCase() === title.toLowerCase()
        );
        if (foundNote) {
          existingNote = await getNote(foundNote.id);
          targetPath = join(vaultPath, foundNote.path);
        }
      }
    }
    if (existingNote && targetPath && mode !== "create") {
      return await appendToNote(existingNote, targetPath, content);
    }
    if (mode === "append") {
      throw new Error(`Note not found for appending: ${idOrPath || title}`);
    }
    return await createNewNote(title, content, tags, folder);
  } catch (error) {
    console.error("Error writing note:", error);
    throw new Error(`Failed to write note: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
async function createNewNote(title, content, tags = [], folder) {
  const targetDir = folder ? join(vaultPath, folder) : vaultPath;
  await fs.mkdir(targetDir, { recursive: true });
  const now = /* @__PURE__ */ new Date();
  const dateStr = now.toISOString().split("T")[0];
  const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const fileName = `${dateStr}-${slug}.md`;
  const relativePath = folder ? join(folder, fileName) : fileName;
  const fullPath = join(vaultPath, relativePath);
  const id = v4();
  const frontMatter = {
    id,
    title,
    date: now.toISOString(),
    tags,
    source: "cli"
  };
  const fileContent = matter.stringify(content, frontMatter);
  await fs.writeFile(fullPath, fileContent, "utf8");
  return {
    id,
    title,
    date: now.toISOString(),
    tags,
    path: relativePath,
    source: "cli",
    fullPath,
    action: "created",
    contentLength: content.length
  };
}
async function appendToNote(existingNote, targetPath, newContent) {
  const currentFileContent = await fs.readFile(targetPath, "utf8");
  const { data: frontMatter, content: currentContent } = matter(currentFileContent);
  const separator = currentContent.trim() ? "\n\n" : "";
  const updatedContent = currentContent + separator + newContent;
  const updatedFrontMatter = {
    ...frontMatter,
    modified: (/* @__PURE__ */ new Date()).toISOString()
  };
  const updatedFileContent = matter.stringify(updatedContent, updatedFrontMatter);
  await fs.writeFile(targetPath, updatedFileContent, "utf8");
  return {
    id: existingNote.id,
    title: existingNote.title,
    date: existingNote.date,
    tags: existingNote.tags,
    path: existingNote.path,
    source: existingNote.source,
    fullPath: targetPath,
    action: "appended",
    contentLength: newContent.length
  };
}

export { getNoteTool, listNotesTool, writeNoteTool };
//# sourceMappingURL=54fae4bf-31ec-4778-9f26-180e4773a86c.mjs.map

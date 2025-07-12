import fg from "fast-glob";
import fs from "node:fs/promises";
import matter from "gray-matter";
import { join, basename, extname, dirname } from "node:path";

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

export interface NoteMeta {
  title: string;
  date: string;
  tags: string[];
  path: string;
  source: "cli" | "external";
}

export interface Note extends NoteMeta {
  body: string;
  fullPath: string;
}

export async function listNotes(): Promise<NoteMeta[]> {
  try {
    const paths = await fg("**/*.md", { cwd: vaultPath, dot: false });
    const metas = await Promise.all(paths.map(parseMeta));
    return metas.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  } catch (error) {
    console.error("Error listing notes:", error);
    return [];
  }
}

export async function getNote(path: string): Promise<Note | null> {
  try {
    const fullPath = join(vaultPath, path);
    await fs.access(fullPath);
    
    const raw = await fs.readFile(fullPath, "utf8");
    const { data, content } = matter(raw);
    const meta = await deriveMeta(data, fullPath);
    return { ...meta, body: content, fullPath };
  } catch (error) {
    // Don't log error - file might not exist, which is normal
    return null;
  }
}

export async function writeNote(
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

export async function removeNote(path: string): Promise<{ path: string; success: boolean; message: string }> {
  try {
    const fullPath = join(vaultPath, path);
    
    // Check if file exists
    await fs.access(fullPath);
    
    // Remove the file
    await fs.unlink(fullPath);
    
    return {
      path,
      success: true,
      message: `Successfully removed note: ${path}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      path,
      success: false,
      message: `Failed to remove note ${path}: ${message}`
    };
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
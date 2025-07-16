import { listNotes } from '../../mastra/core/notes.js';
import { dirname } from 'node:path';
import logger from '../../mastra/utils/logger.js';

interface ListOptions {
  tags?: string;
  json?: boolean;
}

export async function handleList(options: ListOptions = {}): Promise<void> {
  try {
    logger.info('📚 Loading notes...');

    const notes = await listNotes();

    if (notes.length === 0) {
      logger.info('📭 No notes found. Use "dome add <topic>" to create your first note!');
      return;
    }

    // Apply filters
    let filteredNotes = notes;

    if (options.tags) {
      const targetTags = options.tags.split(',').map(tag => tag.trim().toLowerCase());
      filteredNotes = filteredNotes.filter(note =>
        note.tags.some(tag => targetTags.some(targetTag => tag.toLowerCase().includes(targetTag)))
      );
    }

    if (options.json) {
      logger.info(JSON.stringify(filteredNotes, null, 2));
      return;
    }

    // Group by directory
    const groupedNotes = groupNotesByDirectory(filteredNotes);

    // Display results
    const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
    logger.info(`\nNotes in ${vaultPath}:\n`);

    for (const [dir, dirNotes] of Object.entries(groupedNotes)) {
      let dirLog = `📁 ${dir}/\n`;

      for (const note of dirNotes) {
        const timeAgo = formatTimeAgo(new Date(note.date));
        const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
        dirLog += `  📝 ${note.path.split('/').pop()}${' '.repeat(Math.max(1, 30 - note.path.split('/').pop()!.length))} (${timeAgo})${tags}\n`;
      }
      logger.info(dirLog);
    }

    logger.info(`Total: ${filteredNotes.length} note${filteredNotes.length !== 1 ? 's' : ''}`);
  } catch (error) {
    logger.error(
      '❌ Failed to list notes:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}

function groupNotesByDirectory(notes: any[]): Record<string, any[]> {
  const groups: Record<string, any[]> = {};

  for (const note of notes) {
    const dir = dirname(note.path);
    const dirName = dir === '.' ? 'root' : dir;

    if (!groups[dirName]) {
      groups[dirName] = [];
    }

    groups[dirName].push(note);
  }

  // Sort notes within each directory by modification date (newest first)
  for (const group of Object.values(groups)) {
    group.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  return groups;
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffDays > 7) {
    return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) !== 1 ? 's' : ''} ago`;
  } else if (diffDays > 0) {
    if (diffDays === 1) return 'yesterday';
    return `${diffDays} days ago`;
  } else if (diffHours > 0) {
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  } else if (diffMinutes > 0) {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
  } else {
    return 'just now';
  }
}

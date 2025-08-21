import { NoteFinder, FindNoteResult } from '../domain/search/NoteFinder.js';
import { NoteManager } from '../services/note-manager.js';
import path from 'node:path';
import chalk from 'chalk';
import { handleNew } from './new.js';
import logger from '../../core/utils/logger.js';
import { promptWithCleanTerminal } from '../utils/prompt-helper.js';

interface FindOptions {
  maxResults?: number;
  minRelevance?: number;
}

/**
 * Find command using vector search only
 */
export async function handleFind(topic: string, options: FindOptions = {}): Promise<void> {
  const { maxResults = 10, minRelevance = 0.4 } = options;

  const finder = new NoteFinder();
  const noteManager = new NoteManager();

  logger.info(`🔍 Searching for notes matching "${topic}"...`);

  // Get vector search results
  const vectorResults = await finder.vectorFindNotes(topic, maxResults * 2);

  // Filter vector results
  const filteredResults = vectorResults
    .filter(r => r.relevanceScore >= minRelevance)
    .slice(0, maxResults);

  // If we have results, use them
  if (filteredResults.length > 0) {
    // Single result - open directly
    if (filteredResults.length === 1) {
      await noteManager.editNote(topic, filteredResults[0].path);
      return;
    }

    // Multiple results - show selection
    await showSelection(topic, filteredResults, noteManager);
    return;
  }

  // No results found
  logger.warn(
    `⚠️  No notes found matching "${topic}" with relevance >= ${Math.round(minRelevance * 100)}%`
  );
  await promptCreateNew(topic);
}

/**
 * Show selection prompt for multiple results
 */
async function showSelection(
  topic: string,
  results: FindNoteResult[],
  noteManager: NoteManager
): Promise<void> {
  const choices = buildChoices(results);

  const { selectedPath } = await promptWithCleanTerminal<{ selectedPath: string | null }>([
    {
      type: 'list',
      name: 'selectedPath',
      message: `Found ${results.length} matching notes:`,
      choices,
      pageSize: 15,
      loop: false,
    },
  ]);

  // Handle selection
  if (selectedPath === '__CREATE_NEW__') {
    await handleNew(topic);
  } else if (!selectedPath) {
    logger.info('🚫 Operation cancelled');
    process.exit(0);
  } else {
    const selectedNote = results.find(r => r.path === selectedPath);
    if (selectedNote) {
      await noteManager.editNote(topic, selectedNote.path);
    }
  }
}

/**
 * Build choices for the selection prompt
 */
function buildChoices(results: FindNoteResult[]): any[] {
  const choices: any[] = results.map((result, index) => {
    const num = (index + 1).toString().padStart(2, ' ');
    const score = Math.round(result.relevanceScore * 100);
    const fileName = path.basename(result.path);
    const scoreText = getScoreColor(result.relevanceScore)(`[${score}%]`);
    const pathText = chalk.cyan(result.path);

    // Format the display name with colored components
    const displayName = `${num}. ${pathText} ${scoreText}`;

    return {
      name: displayName,
      value: result.path,
      short: fileName,
    };
  });

  // Add separator
  choices.push({
    name: '─'.repeat(60),
    value: 'separator',
    short: '',
    disabled: true,
  });

  // Add create new note option
  choices.push({
    name: '✨ Create new note',
    value: '__CREATE_NEW__',
    short: 'Create new',
  });

  // Add cancel option
  choices.push({
    name: '❌ Cancel',
    value: null,
    short: 'Cancel',
  });

  return choices;
}

/**
 * Prompt to create a new note
 */
async function promptCreateNew(topic: string): Promise<void> {
  const { createNew } = await promptWithCleanTerminal<{ createNew: boolean }>([
    {
      type: 'confirm',
      name: 'createNew',
      message: 'Would you like to create a new note?',
      default: true,
    },
  ]);

  if (createNew) {
    await handleNew(topic);
  } else {
    process.exit(0);
  }
}

/**
 * Get color for relevance score
 */
function getScoreColor(score: number): (text: string) => string {
  if (score >= 0.8) return chalk.greenBright;
  if (score >= 0.6) return chalk.yellowBright;
  return chalk.redBright;
}

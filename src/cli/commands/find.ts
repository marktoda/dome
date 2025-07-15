import { AINoteFinder, FindNoteResult } from '../services/note-finder.js';
import { NoteManager } from '../services/note-manager.js';
import inquirer from 'inquirer';
import path from 'node:path';
import chalk from 'chalk';
import { handleNew } from './new.js';
import logger from '../../mastra/utils/logger.js';

interface FindOptions {
  maxResults?: number;
  useAIFallback?: boolean;
  minRelevance?: number;
}

/**
 * Find command that shows vector results immediately
 * and uses AI results only when vector search has no results
 */
export async function handleFind(topic: string, options: FindOptions = {}): Promise<void> {
  const {
    maxResults = 10,
    useAIFallback = true,
    minRelevance = 0.4
  } = options;

  try {
    const finder = new AINoteFinder();
    const noteManager = new NoteManager();

    logger.info(`🔍 Searching for notes matching "${topic}"...`);

    // Get both vector and AI search started
    const { vectorResults, aiResultsPromise } = await finder.findNotes(topic, maxResults * 2);

    // Filter vector results
    const filteredVectorResults = vectorResults
      .filter(r => r.relevanceScore >= minRelevance)
      .slice(0, maxResults);

    // If we have vector results, use them
    if (filteredVectorResults.length > 0) {
      // Single result - open directly
      if (filteredVectorResults.length === 1) {
        await noteManager.editNote(topic, filteredVectorResults[0].path);
        return;
      }

      // Multiple results - show selection
      await showSelection(topic, filteredVectorResults, noteManager);
      return;
    }

    // No vector results - try AI if enabled
    if (useAIFallback) {
      logger.debug('No local results found, waiting for AI search...');

      try {
        const aiResults = await aiResultsPromise;
        const filteredAIResults = aiResults
          .filter(r => r.relevanceScore >= minRelevance)
          .slice(0, maxResults);

        if (filteredAIResults.length > 0) {
          // Single AI result - open directly
          if (filteredAIResults.length === 1) {
            await noteManager.editNote(topic, filteredAIResults[0].path);
            return;
          }

          // Multiple AI results - show selection
          logger.info('✨ Found results with AI search!');
          await showSelection(topic, filteredAIResults, noteManager);
          return;
        }
      } catch (error) {
        logger.warn('⚠️  AI search failed:', error instanceof Error ? error.message : 'Unknown error');
      }
    }

    // No results found
    logger.warn(`⚠️  No notes found matching "${topic}" with relevance >= ${Math.round(minRelevance * 100)}%`);
    await promptCreateNew(topic);

  } catch (error) {
    if (error instanceof Error && error.message.includes('SIGINT')) {
      logger.warn('\n🚫 Search cancelled');
    } else {
      logger.error('❌ Failed to find notes:', error instanceof Error ? error.message : 'Unknown error');
    }
    process.exit(1);
  }
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

  const { selectedPath } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedPath',
      message: `Found ${results.length} matching notes:`,
      choices,
      pageSize: 15,
      loop: false
    }
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
      short: fileName
    };
  });

  // Add separator
  choices.push({
    name: '─'.repeat(60),
    value: 'separator',
    short: '',
    disabled: true
  });

  // Add create new note option
  choices.push({
    name: '✨ Create new note',
    value: '__CREATE_NEW__',
    short: 'Create new'
  });

  // Add cancel option
  choices.push({
    name: '❌ Cancel',
    value: null,
    short: 'Cancel'
  });

  return choices;
}

/**
 * Prompt to create a new note
 */
async function promptCreateNew(topic: string): Promise<void> {
  const { createNew } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'createNew',
      message: 'Would you like to create a new note?',
      default: true
    }
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

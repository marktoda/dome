import { AINoteFinder, FindNoteResult } from '../actions/note-finder.js';
import { DefaultEditorService } from '../services/editor-service.js';
import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'node:path';
import { handleNew } from './new.js';

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
    const editor = new DefaultEditorService();

    console.log(chalk.blue(`🔍 Searching for notes matching "${topic}"...`));

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
        await openNote(filteredVectorResults[0], editor);
        return;
      }
      
      // Multiple results - show selection
      await showSelection(topic, filteredVectorResults, editor);
      return;
    }
    
    // No vector results - try AI if enabled
    if (useAIFallback) {
      console.log(chalk.gray('No local results found, waiting for AI search...'));
      
      try {
        const aiResults = await aiResultsPromise;
        const filteredAIResults = aiResults
          .filter(r => r.relevanceScore >= minRelevance)
          .slice(0, maxResults);
        
        if (filteredAIResults.length > 0) {
          // Single AI result - open directly
          if (filteredAIResults.length === 1) {
            await openNote(filteredAIResults[0], editor);
            return;
          }
          
          // Multiple AI results - show selection
          console.log(chalk.green('✨ Found results with AI search!'));
          await showSelection(topic, filteredAIResults, editor);
          return;
        }
      } catch (error) {
        console.error(chalk.yellow('⚠️  AI search failed:'), error instanceof Error ? error.message : 'Unknown error');
      }
    }
    
    // No results found
    console.log(chalk.yellow(`⚠️  No notes found matching "${topic}" with relevance >= ${Math.round(minRelevance * 100)}%`));
    await promptCreateNew(topic);
    
  } catch (error) {
    if (error instanceof Error && error.message.includes('SIGINT')) {
      console.log(chalk.yellow('\n🚫 Search cancelled'));
    } else {
      console.error(chalk.red('❌ Failed to find notes:'), error instanceof Error ? error.message : 'Unknown error');
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
  editor: DefaultEditorService
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
    console.log(chalk.yellow('🚫 Operation cancelled'));
    process.exit(0);
  } else {
    const selectedNote = results.find(r => r.path === selectedPath);
    if (selectedNote) {
      await openNote(selectedNote, editor);
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
    
    // Color code based on relevance
    const scoreColor = getScoreColor(result.relevanceScore);
    
    // Format the display name
    const displayName = `${chalk.bold(num)}. ${result.path} ${scoreColor(`[${score}%]`)}`;
    
    return {
      name: displayName,
      value: result.path,
      short: fileName
    };
  });
  
  // Add separator
  choices.push({
    name: chalk.dim('─'.repeat(60)),
    value: 'separator',
    short: '',
    disabled: true
  });
  
  // Add create new note option
  choices.push({
    name: chalk.green('✨ Create new note'),
    value: '__CREATE_NEW__',
    short: 'Create new'
  });
  
  // Add cancel option
  choices.push({
    name: chalk.red('❌ Cancel'),
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
 * Open a note in the editor
 */
async function openNote(note: FindNoteResult, editor: DefaultEditorService): Promise<void> {
  console.log(chalk.green(`📖 Opening note: ${note.path}`));
  
  const success = await editor.openNote(note.path, false);
  
  if (success) {
    console.log(chalk.green('✅ Note opened successfully'));
  } else {
    console.error(chalk.red('❌ Error opening note'));
    process.exit(1);
  }
}

/**
 * Get color for relevance score
 */
function getScoreColor(score: number): (text: string) => string {
  if (score >= 0.8) return chalk.green;
  if (score >= 0.6) return chalk.yellow;
  return chalk.gray;
}

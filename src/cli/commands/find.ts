import { AINoteFinder } from '../actions/note-finder.js';
import { vectorFindNotes } from '../actions/vector-finder.js';
import { DefaultEditorService } from '../services/editor-service.js';
import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'node:path';

export async function handleFind(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
    const editor = new DefaultEditorService();

    console.log(`🔍 Searching for notes matching "${topic}"...`);

    // --- Fast local vector search first ---
    let vectorResults = await vectorFindNotes(topic, 10);

    let results;

    if (vectorResults.length > 0) {
      results = {
        results: vectorResults,
        totalFound: vectorResults.length,
      };
    } else {
      // Fallback to AI search (slower)
      results = await finder.findMultipleNotes(topic);
    }
    
    if (results.totalFound === 0) {
      console.error(`❌ No notes found matching "${topic}"`);
      process.exit(1);
    }
    
    // If only one result, open it directly
    if (results.results.length === 1) {
      const note = results.results[0];
      console.log(`📖 Opening note: ${note.path}`);
      
      const success = await editor.openNote(note.path, false);
      
      if (success) {
        console.log('✅ Note opened successfully');
      } else {
        console.error('❌ Error opening note');
        process.exit(1);
      }
      return;
    }
    
    // Remove duplicates based on file path
    const uniqueResults = results.results.filter((result, index, self) => 
      index === self.findIndex((r) => r.path === result.path)
    );
    
    // Display header but rely on interactive list for entries
    console.log(`\n📚 Found ${uniqueResults.length} matching notes:\n`);
    
    // Prepare choices for inquirer with cleaner format
    const choices: any[] = uniqueResults.map((result, index) => {
      const num = (index + 1).toString().padStart(2, ' ');
      const score = Math.round(result.relevanceScore * 100);
      const fileName = path.basename(result.path);
      const dirPath = path.dirname(result.path);
      
      // Color based on relevance
      const scoreColor = result.relevanceScore >= 0.8 ? chalk.green : 
                        result.relevanceScore >= 0.6 ? chalk.yellow : 
                        chalk.gray;
      
      // Create a clean, single-line format
      let name = chalk.bold(`${num}. ${result.path}`);
      name += ` ${scoreColor(`[${score}%]`)}`;
      
      return {
        name,
        value: result.path,
        short: fileName
      };
    });
    
    // Add a separator before cancel option
    choices.push({
      name: chalk.dim('─'.repeat(60)),
      value: 'separator',
      short: '',
      disabled: true
    });
    
    // Add cancel option
    choices.push({
      name: chalk.red('❌ Cancel'),
      value: null,
      short: 'Cancel'
    });
    
    // Ask user to select a note
    const { selectedPath } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedPath',
        message: '',
        choices,
        pageSize: 20
      }
    ]);
    
    // Handle cancellation
    if (!selectedPath) {
      console.log('🚫 Operation cancelled');
      process.exit(0);
    }
    
    // Open selected note
    console.log(`\n📖 Opening note: ${selectedPath}`);
    
    const success = await editor.openNote(selectedPath, false);
    
    if (success) {
      console.log('✅ Note opened successfully');
    } else {
      console.error('❌ Error opening note');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Failed to find notes:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
import { AINoteFinder } from '../actions/note-finder.js';
import { DefaultEditorService } from '../services/editor-service.js';
import inquirer from 'inquirer';
import chalk from 'chalk';

export async function handleFind(topic: string): Promise<void> {
  try {
    const finder = new AINoteFinder();
    const editor = new DefaultEditorService();
    
    console.log(`🔍 Searching for notes matching "${topic}"...`);
    
    // Find multiple notes sorted by relevance
    const results = await finder.findMultipleNotes(topic);
    
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
    
    // Display results with relevance scores
    console.log(`\n📚 Found ${results.totalFound} matching notes:\n`);
    
    // Prepare choices for inquirer
    const choices: Array<{ name: string; value: string | null; short: string }> = results.results.map((result, index) => {
      const relevanceBar = '█'.repeat(Math.round(result.relevanceScore * 10));
      const emptyBar = '░'.repeat(10 - Math.round(result.relevanceScore * 10));
      const scoreColor = result.relevanceScore >= 0.8 ? chalk.green : 
                        result.relevanceScore >= 0.6 ? chalk.yellow : 
                        chalk.gray;
      
      let name = `${index + 1}. ${result.title}`;
      name += `\n   ${scoreColor(relevanceBar + emptyBar)} ${scoreColor((result.relevanceScore * 100).toFixed(0) + '%')}`;
      name += chalk.dim(`\n   ${result.path}`);
      
      if (result.excerpt) {
        name += chalk.dim(`\n   "${result.excerpt.substring(0, 50)}..."`);
      }
      
      if (result.reason) {
        name += chalk.italic(`\n   ${result.reason}`);
      }
      
      return {
        name,
        value: result.path,
        short: result.title
      };
    });
    
    // Add cancel option
    choices.push({
      name: chalk.red('\n❌ Cancel'),
      value: null,
      short: 'Cancel'
    });
    
    // Ask user to select a note
    const { selectedPath } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedPath',
        message: 'Select a note to open:',
        choices,
        pageSize: 10
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
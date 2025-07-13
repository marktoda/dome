/**
 * Setup command for initializing context configurations
 */

import { ContextManager } from '../../mastra/core/context/manager.js';
import { loadDefaultTemplates } from '../../mastra/core/context/templates.js';
import { listContextFiles } from '../../mastra/core/context/parser.js';
import { join } from 'node:path';
import fg from 'fast-glob';

const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;

export async function handleSetup(): Promise<void> {
  console.log('🏠 Dome Context Setup\n');
  console.log('Scanning vault structure...\n');
  
  try {
    // Get all directories
    const allDirs = await fg('**/', {
      cwd: vaultPath,
      onlyDirectories: true,
      ignore: ['node_modules', '.git', '.vector_db', '.*'],
    });
    
    // Add root directory
    allDirs.unshift('.');
    
    // Get existing context files
    const contextFiles = await listContextFiles(vaultPath);
    const contextsSet = new Set(
      contextFiles.map(f => {
        const dir = f.replace(vaultPath, '').replace(/^\//,'').replace('/.dome', '');
        return dir || '.';
      })
    );
    
    // Filter out directories that already have contexts
    const foldersWithoutContext = allDirs.filter(dir => !contextsSet.has(dir));
    
    if (foldersWithoutContext.length === 0) {
      console.log('✓ All folders already have context configurations!');
      console.log('\nUse "dome context list" to see existing contexts.');
      return;
    }
    
    console.log(`Found ${foldersWithoutContext.length} folders without context files:\n`);
    
    // Show folders
    foldersWithoutContext.forEach(folder => {
      console.log(`  • ${folder === '.' ? '/ (root)' : folder}`);
    });
    
    console.log('\nTo create contexts for these folders, use:');
    console.log('  dome context create <folder> --template <template>');
    console.log('\nAvailable templates: meetings, journal, projects, ideas, reading');
    console.log('\nExample:');
    console.log('  dome context create meetings --template meetings');
    console.log('  dome context create projects/myapp --template projects');
    
    // Suggest smart defaults based on folder names
    console.log('\nSuggested commands based on folder names:');
    
    const templates = await loadDefaultTemplates();
    let suggestions = 0;
    
    for (const folder of foldersWithoutContext.slice(0, 5)) { // Show max 5 suggestions
      const folderName = folder === '.' ? 'root' : folder.split('/').pop() || folder;
      
      // Try to match folder name to template
      const template = templates.find(t => 
        folderName.toLowerCase().includes(t.id) ||
        t.id.includes(folderName.toLowerCase()) ||
        (t.id === 'meetings' && folderName.match(/meet|1-1|standup/i)) ||
        (t.id === 'journal' && folderName.match(/daily|journal|diary|log/i)) ||
        (t.id === 'projects' && folderName.match(/project|work|task/i)) ||
        (t.id === 'reading' && folderName.match(/book|read|article|paper/i))
      );
      
      if (template) {
        console.log(`  dome context create "${folder}" --template ${template.id}`);
        suggestions++;
      }
    }
    
    if (suggestions === 0) {
      console.log('  dome context create "." --template ideas  # For root folder');
    }
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}
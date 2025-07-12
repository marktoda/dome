import { createInterface } from 'node:readline';
import { mastra } from '../../mastra/index.js';
import { listNotes, type NoteMeta } from '../../mastra/core/notes.js';

export async function handleChat(): Promise<void> {
  const session = new DomeChatSession();
  await session.start();
}

class DomeChatSession {
  private rl: any;
  private running = true;

  async start(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });

    // Display welcome message
    await this.showWelcome();
    
    this.rl.prompt();
    this.rl.on('line', this.handleInput.bind(this));
    this.rl.on('close', this.end.bind(this));
  }

  private async showWelcome(): Promise<void> {
    console.log('🏠 Dome AI Assistant\n');
    
    try {
      const notes = await listNotes();
      const vaultPath = process.env.DOME_VAULT_PATH ?? `${process.env.HOME}/dome`;
      console.log(`Connected to vault: ${vaultPath} (${notes.length} notes)`);
    } catch (error) {
      console.log('Connected to vault (unable to count notes)');
    }
    
    console.log("Type 'help' for commands, 'exit' to quit\n");
  }

  private async handleInput(input: string): Promise<void> {
    const trimmed = input.trim();
    
    if (!trimmed) {
      this.rl.prompt();
      return;
    }
    
    // Handle built-in commands
    if (await this.handleBuiltinCommand(trimmed)) {
      this.rl.prompt();
      return;
    }
    
    // Route to AI agent
    try {
      const response = await this.processQuery(trimmed);
      console.log(response);
    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error');
    }
    
    if (this.running) {
      this.rl.prompt();
    }
  }

  private async handleBuiltinCommand(input: string): Promise<boolean> {
    const [command, ...args] = input.split(' ');
    
    switch (command.toLowerCase()) {
      case 'help':
        this.showHelp();
        return true;
        
      case 'exit':
      case 'quit':
      case 'q':
        this.end();
        return true;
        
      case 'clear':
        console.clear();
        await this.showWelcome();
        return true;
        
      case 'list':
        await this.quickList();
        return true;
        
      default:
        return false;
    }
  }

  private showHelp(): void {
    console.log(`
📖 Dome AI Assistant Help

Built-in commands:
  help              Show this help message
  list              Quick list of all notes
  clear             Clear screen
  exit, quit, q     Exit the assistant

AI capabilities:
  • Ask questions about your notes
  • Summarize content across multiple notes  
  • Create new notes or append to existing ones
  • Search for specific topics or keywords
  • Generate todo lists from meeting notes

Examples:
  > summarize my meeting notes from this week
  > find notes about the new feature
  > create a todo list from my project notes
  > what did I write about the architecture review?
  > show me all notes tagged with "planning"
`);
  }

  private async quickList(): Promise<void> {
    try {
      const notes = await listNotes();
      
      if (notes.length === 0) {
        console.log('📭 No notes found');
        return;
      }
      
      console.log(`📚 ${notes.length} notes:`);
      
      // Show recent notes (last 10)
      const recentNotes = notes
        .sort((a: NoteMeta, b: NoteMeta) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 10);
      
      for (const note of recentNotes) {
        const timeAgo = this.formatTimeAgo(new Date(note.date));
        console.log(`  📝 ${note.title} (${timeAgo})`);
      }
      
      if (notes.length > 10) {
        console.log(`  ... and ${notes.length - 10} more notes`);
      }
    } catch (error) {
      console.error('❌ Failed to list notes:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private async processQuery(input: string): Promise<string> {
    try {
      const agent = mastra.getAgent('notesAgent');
      if (!agent) {
        throw new Error('Notes agent not found');
      }
      
      const response = await agent.generate([
        { role: 'user', content: input }
      ]);
      
      return response.text || 'I apologize, but I couldn\'t process your request. Please try rephrasing your question.';
    } catch (error) {
      throw new Error(`Failed to process query: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffDays > 0) {
      if (diffDays === 1) return 'yesterday';
      return `${diffDays}d ago`;
    } else if (diffHours > 0) {
      return `${diffHours}h ago`;
    } else {
      return 'today';
    }
  }

  end(): void {
    this.running = false;
    console.log('\n👋 Goodbye! Your notes are safe in the vault.');
    this.rl.close();
    process.exit(0);
  }
}
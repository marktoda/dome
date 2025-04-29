import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { chat, ChatMessageChunk } from '../../utils/api';

// Define source info interface for type safety
interface SourceInfo {
  id?: string;
  title?: string;
  source?: string;
  url?: string;
  relevanceScore?: number;
  snippet?: string;
}

type Conversation = {
  user: string;
  thinking: string;
  reply: string;
};

/* ------------------------------------------------------------------ */
/*  ChatMode                                                           */
/* ------------------------------------------------------------------ */

export class ChatMode extends BaseMode {
  private static readonly MAX_LINES = 1_000;
  private static readonly MAX_LINE_LEN = 5_000;
  private static readonly MAX_SOURCES = 5;
  private static readonly HEADER = [
    '{center}{bold}Chat Mode{/bold}{/center}',
    '{center}Type a message to chat with Dome AI{/center}',
    '',
  ];

  /** Accumulates stream chunks until a valid JSON object can be parsed. */
  private thinkingBuffer = new class {
    private buf = '';

    tryPush(fragment: string): string {
      this.buf += fragment;
      return this.buf;
    }

    reset(): void {
      this.buf = '';
    }
  }();

  constructor() {
    super({
      id: 'chat',
      name: 'Chat',
      description: 'Chat with Dome AI',
      shortcut: 'C-t',
      color: 'green',
    });
  }

  /* ------------------------------------------------------------------ */
  /*  lifecycle                                                         */
  /* ------------------------------------------------------------------ */

  protected onInit(): void {/* nothing */ }

  protected onActivate(): void {
    this.configureContainer();
    this.container.setLabel(' Chat with Dome ');
    this.renderHeader();
  }

  protected onDeactivate(): void {/* nothing */ }

  /* ------------------------------------------------------------------ */
  /*  input handler                                                     */
  /* ------------------------------------------------------------------ */

  async handleInput(input: string): Promise<void> {
    this.configureContainer();
    const cw = (this.container as any).width - 4;

    const convo: Conversation = { user: input, thinking: '', reply: '' };
    const rebuild = () => this.renderConversation(convo, cw);

    rebuild();
    this.setStatus('Dome is thinking…');

    /* stream handler ------------------------------------------------- */
    let startedContent = false;
    const onChunk = (chunk: string | ChatMessageChunk) => {
      if (typeof chunk === 'string') {
        convo.reply += chunk;
        startedContent = true;
      } else if (chunk.type === 'thinking' && !startedContent) {
        // Try to handle the thinking content better
        const content = this.thinkingBuffer.tryPush(chunk.content);
        
        // Only display thinking content if we have a reasonable amount
        // and suppress raw JSON that's not useful to display
        try {
          // Try to parse as JSON
          const parsed = JSON.parse(content);
          
          // If it's an array with one element that's a string, just show that
          if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') {
            convo.thinking = parsed[0];
          }
          // If it's an object with a reasoning property, extract that
          else if (parsed && typeof parsed === 'object' && parsed.reasoning) {
            if (Array.isArray(parsed.reasoning) && parsed.reasoning.length > 0) {
              // Take the last reasoning element if it's an array
              convo.thinking = parsed.reasoning[parsed.reasoning.length - 1];
            } else if (typeof parsed.reasoning === 'string') {
              convo.thinking = parsed.reasoning;
            } else {
              // Just show a simple thinking indicator
              convo.thinking = "Thinking...";
            }
          } else {
            // Skip showing large complex JSON objects
            convo.thinking = "Thinking...";
          }
        } catch {
          // If it's not JSON, take it as is if it's reasonable
          if (content.length < 300) {
            convo.thinking = content;
          } else {
            convo.thinking = "Thinking...";
          }
        }
      } else if (chunk.type === 'content') {
        // Reset thinking buffer when content starts
        this.thinkingBuffer.reset();
        convo.reply += chunk.content;
        startedContent = true;
      } else if (chunk.type === 'final') {
        // Final chunks with sources don't need to add content to the reply
        // The sources will be displayed separately
        startedContent = true;
      } else if (chunk.type === 'unknown') {
        // Handle unknown chunks (could be plain text)
        if (!startedContent && chunk.content.trim()) {
          // Try to see if it's thinking content
          try {
            const parsed = JSON.parse(chunk.content);
            if (parsed && typeof parsed === 'object') {
              convo.thinking = JSON.stringify(parsed, null, 2);
            } else {
              convo.reply += chunk.content;
              startedContent = true;
            }
          } catch {
            // Not JSON, treat as regular content
            convo.reply += chunk.content;
            startedContent = true;
          }
        } else {
          convo.reply += chunk.content;
          startedContent = true;
        }
      } else {
        // Any other chunk type
        convo.reply += chunk.content || '';
        startedContent = true;
      }
      rebuild();
    };

    /* api call ------------------------------------------------------- */
    try {
      const verbose = process.env.DOME_VERBOSE === 'true' ||
        process.argv.includes('-v') || process.argv.includes('--verbose');

      const result = await chat(input, onChunk, { debug: verbose });

      /* sources ------------------------------------------------------ */
      // Process sources if available in multiple possible locations
      let sources: SourceInfo[] = [];
      if (result?.sources?.length) {
        sources = result.sources;
      } else if (result?.node?.sources) {
        // Handle sources from final chunk format
        sources = Array.isArray(result.node.sources)
          ? result.node.sources
          : [result.node.sources];
      }

      if (sources?.length) {
        // Filter out metadata entries and other non-displayable sources
        sources = sources.filter((source: SourceInfo) => {
          const title = source.title || '';
          return !title.includes('---DOME-METADATA-START---') &&
                 !title.match(/^---.*---$/) &&
                 title.trim() !== '';
        });
        
        // Sort by relevance score (highest first)
        sources.sort((a: SourceInfo, b: SourceInfo) =>
          (b.relevanceScore || 0) - (a.relevanceScore || 0)
        );
        
        // Display top sources
        this.displaySources(sources.slice(0, ChatMode.MAX_SOURCES), cw, sources.length);
        this.scrollToBottom();
      }
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.printBlock('{bold}{red-fg}Error:{/red-fg}{/bold}', `I encountered an error: ${msg}`, cw);
    } finally {
      this.setStatus(); // reset
    }
  }

  /* ------------------------------------------------------------------ */
  /*  rendering helpers                                                 */
  /* ------------------------------------------------------------------ */

  private renderHeader(): void {
    this.container.setContent(ChatMode.HEADER.join('\n'));
    this.screen.render();
  }

  private renderConversation({ user, thinking, reply }: Conversation, cw: number): void {
    this.container.setContent('');
    ChatMode.HEADER.forEach(l => this.container.pushLine(l));

    this.printBlock('{bold}{green-fg}You:{/green-fg}{/bold}', user, cw);
    
    // Only display thinking if it looks meaningful and it's not just "Thinking..."
    if (thinking && thinking !== "Thinking..." && thinking.length > 1) {
      this.printBlock('{gray-fg}Thinking:{/gray-fg}', thinking, cw);
    }
    
    if (reply) this.printBlock('{bold}{blue-fg}Dome:{/blue-fg}{/bold}', reply, cw);

    this.scrollToBottom();
  }

  private printBlock(header: string, text: string, cw: number): void {
    this.container.pushLine(header);
    this.wrapText(text, cw);
    this.container.pushLine('');
    this.enforceLimit();
  }

  private wrapText(text: string, cw: number): void {
    if (!text) { this.container.pushLine(''); return; }

    const safeWidth = Math.max(cw - 2, 10);
    const lines = text
      .split('\n')
      .flatMap(line => this.wordWrap(line, safeWidth));

    lines.forEach(l => this.container.pushLine(l));
  }

  private wordWrap(line: string, width: number): string[] {
    if (line.length <= width) return [line];

    const out: string[] = [];
    let cur = '';
    for (const word of line.split(' ')) {
      if (word.length > width) {
        if (cur) { out.push(cur); cur = ''; }
        let w = word;
        while (w.length > width) {
          out.push(w.slice(0, width - 1) + '-');
          w = w.slice(width - 1);
        }
        cur = w;
      } else if ((cur + ' ' + word).trim().length <= width) {
        cur = (cur ? cur + ' ' : '') + word;
      } else {
        out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  private displaySources(sources: SourceInfo[], cw: number, totalCount?: number): void {
    this.container.pushLine('{bold}Sources:{/bold}');
    sources.forEach((s, i) => {
      // Safely handle potentially undefined title
      const title = s.title
        ? (s.title.length > 80 ? s.title.slice(0, 80) + '…' : s.title)
        : 'Unnamed Source';
      
      // Display index and title
      this.container.pushLine(`${i + 1}. {underline}${title}{/underline}`);
      
      // Display source type
      if (s.source) {
        this.container.pushLine(`   Source: ${s.source}`);
      }
      
      // Display URL if available
      if (s.url) {
        this.container.pushLine(`   URL: {blue-fg}${s.url}{/blue-fg}`);
      }
      
      // Display relevance score with color coding
      if (s.relevanceScore !== undefined) {
        const scorePercentage = Math.round(s.relevanceScore * 100);
        const scoreColor = scorePercentage > 70 ? 'green' : scorePercentage > 40 ? 'yellow' : 'red';
        this.container.pushLine(`   Relevance: {${scoreColor}-fg}${scorePercentage}%{/${scoreColor}-fg}`);
      }
      
      // Display snippet if available
      if (s.snippet) {
        this.wrapText('   ' + s.snippet.slice(0, 100) + (s.snippet.length > 100 ? '…' : ''), cw);
      }
      
      // Add space between sources (except after the last one)
      if (i < sources.length - 1) {
        this.container.pushLine('');
      }
    });
    
    // Show total count info if needed
    const total = totalCount || sources.length;
    if (total > sources.length) {
      this.container.pushLine(`{italic}(showing ${sources.length} of ${total}){/italic}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  container helpers                                                 */
  /* ------------------------------------------------------------------ */

  private configureContainer(): void {
    const c = this.container as any;
    Object.assign(c, {
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      wrap: false,
      padding: { left: 1, right: 1 },
      scrollbar: { ch: '█', style: { inverse: true }, track: { bg: 'black' } },
    });
  }

  private scrollToBottom(): void {
    this.container.setScrollPerc(100);
    this.screen.render();
  }

  private enforceLimit(): void {
    const lines = (this.container.getContent() ?? '').split('\n');
    if (lines.length <= ChatMode.MAX_LINES) return;

    const keep = ChatMode.MAX_LINES - 4; // header + notice
    const newContent = [
      ...lines.slice(0, 3),
      '{yellow-fg}[Older messages removed]{/yellow-fg}',
      ...lines.slice(lines.length - keep),
    ].join('\n');
    this.container.setContent(newContent);
  }

  private setStatus(msg?: string): void {
    const text = msg
      ? ` {bold}Status:{/bold} ${msg}`
      : ` {bold}Mode:{/bold} {${this.config.color}-fg}${this.config.name}{/${this.config.color}-fg} | ${this.config.description}`;
    this.statusBar.setContent(text);
    this.screen.render();
  }

  /* ------------------------------------------------------------------ */
  /*  help                                                              */
  /* ------------------------------------------------------------------ */

  getHelpText(): string {
    return `
{bold}Chat Mode Help{/bold}

Type a message and press Enter to chat with Dome AI.

{bold}Commands:{/bold}
  {cyan-fg}/help{/cyan-fg}   Show this help
  {cyan-fg}/clear{/cyan-fg}  Clear the chat

{bold}Shortcut:{/bold}
  {cyan-fg}${this.config.shortcut}{/cyan-fg} – switch to Chat Mode
`;
  }
}

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

  /** Processes thinking content and maintains state between chunks */
  private thinkingProcessor = new (class {
    private buffer = '';
    private lastThinking = '';
    private isJson = false;

    /** Add a new thinking chunk and return processed thinking content */
    process(chunk: string): string {
      this.buffer += chunk;

      // Try to extract meaningful thinking content
      try {
        const parsed = JSON.parse(this.buffer);
        this.isJson = true;

        // Extract thinking from various formats
        if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') {
          this.lastThinking = parsed[0];
        } else if (parsed && typeof parsed === 'object') {
          if (parsed.reasoning) {
            if (Array.isArray(parsed.reasoning) && parsed.reasoning.length > 0) {
              this.lastThinking = parsed.reasoning[parsed.reasoning.length - 1];
            } else if (typeof parsed.reasoning === 'string') {
              this.lastThinking = parsed.reasoning;
            }
          } else if (parsed.thinking && typeof parsed.thinking === 'string') {
            this.lastThinking = parsed.thinking;
          } else if (parsed.thought && typeof parsed.thought === 'string') {
            this.lastThinking = parsed.thought;
          } else {
            // For other object formats, try to extract first string property
            for (const key in parsed) {
              if (typeof parsed[key] === 'string' && parsed[key].length > 10) {
                this.lastThinking = parsed[key];
                break;
              }
            }
          }
        }
      } catch (e) {
        // Not JSON, check if thinking content is readable as plain text
        this.isJson = false;
        if (this.buffer.length < 500 && !this.buffer.includes('{') && !this.buffer.includes('[')) {
          this.lastThinking = this.buffer;
        }
      }

      return this.lastThinking || 'Thinking...';
    }

    reset(): void {
      this.buffer = '';
      this.lastThinking = '';
      this.isJson = false;
    }
  })();

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

  protected onInit(): void {
    /* nothing */
  }

  protected onActivate(): void {
    this.configureContainer();
    this.container.setLabel(' Chat with Dome ');
    this.renderHeader();
  }

  protected onDeactivate(): void {
    /* nothing */
  }

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
        // Handle plain string chunk (typically final response)
        convo.reply += chunk;
        startedContent = true;
      } else if (chunk.type === 'thinking' && !startedContent) {
        // Process thinking chunk and display it properly
        convo.thinking = this.thinkingProcessor.process(chunk.content);
      } else if (chunk.type === 'content') {
        // When content starts, reset thinking processor
        if (!startedContent) {
          this.thinkingProcessor.reset();
        }
        convo.reply += chunk.content || '';
        startedContent = true;
      } else if (chunk.type === 'sources') {
        // Final chunks with sources don't need to add content to the reply
        startedContent = true;
      } else if (chunk.type === 'unknown') {
        // Handle unknown chunks
        if (!startedContent) {
          // Try to determine if it's thinking content
          try {
            const parsed = JSON.parse(chunk.content);
            if (parsed && typeof parsed === 'object') {
              // Process as thinking
              convo.thinking = this.thinkingProcessor.process(chunk.content);
            } else {
              // Treat as reply content
              convo.reply += chunk.content || '';
              startedContent = true;
            }
          } catch {
            // Not JSON, check if it looks like thinking or regular content
            if (chunk.content.includes('thinking') || chunk.content.includes('Thinking')) {
              convo.thinking = chunk.content;
            } else {
              convo.reply += chunk.content || '';
              startedContent = true;
            }
          }
        } else {
          // If content already started, append to reply
          convo.reply += chunk.content || '';
        }
      }

      rebuild();
    };

    /* api call ------------------------------------------------------- */
    try {
      const verbose =
        process.env.DOME_VERBOSE === 'true' ||
        process.argv.includes('-v') ||
        process.argv.includes('--verbose');

      const result = await chat(input, onChunk, { debug: verbose });

      /* sources ------------------------------------------------------ */
      // Process sources if available in multiple possible locations
      let sources: SourceInfo[] = [];
      if (result?.sources?.length) {
        sources = result.sources;
      } else if (result?.node?.sources) {
        // Handle sources from final chunk format
        sources = Array.isArray(result.node.sources) ? result.node.sources : [result.node.sources];
      }

      if (sources?.length) {
        // Filter out metadata entries and other non-displayable sources
        sources = sources.filter((source: SourceInfo) => {
          const title = source.title || '';
          return (
            !title.includes('---DOME-METADATA-START---') &&
            !title.match(/^---.*---$/) &&
            title.trim() !== ''
          );
        });

        // Sort by relevance score (highest first)
        sources.sort(
          (a: SourceInfo, b: SourceInfo) => (b.relevanceScore || 0) - (a.relevanceScore || 0),
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

    // Format and display thinking content if available
    if (thinking && thinking !== 'Thinking...' && thinking.length > 1) {
      // Break thinking into paragraphs and format as readable content
      const formattedThinking = thinking.replace(/\n\n+/g, '\n\n').replace(/\s+/g, ' ').trim();

      this.printBlock('{bold}{gray-fg}Thinking:{/gray-fg}{/bold}', formattedThinking, cw);
    }

    if (reply) {
      this.printBlock('{bold}{blue-fg}Dome:{/blue-fg}{/bold}', reply, cw);
    }

    this.scrollToBottom();
  }

  private printBlock(header: string, text: string, cw: number): void {
    this.container.pushLine(header);
    this.wrapText(text, cw);
    this.container.pushLine('');
    this.enforceLimit();
  }

  private wrapText(text: string, cw: number): void {
    if (!text) {
      this.container.pushLine('');
      return;
    }

    const safeWidth = Math.max(cw - 2, 10);
    const lines = text.split('\n').flatMap(line => this.wordWrap(line, safeWidth));

    lines.forEach(l => this.container.pushLine(l));
  }

  private wordWrap(line: string, width: number): string[] {
    if (line.length <= width) return [line];

    const out: string[] = [];
    let cur = '';
    for (const word of line.split(' ')) {
      if (word.length > width) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
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
        ? s.title.length > 80
          ? s.title.slice(0, 80) + '…'
          : s.title
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
        this.container.pushLine(
          `   Relevance: {${scoreColor}-fg}${scorePercentage}%{/${scoreColor}-fg}`,
        );
      }

      // Display snippet if available
      if (s.snippet) {
        const truncatedSnippet = s.snippet.length > 150 ? s.snippet.slice(0, 150) + '…' : s.snippet;
        this.wrapText('   ' + truncatedSnippet, cw);
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

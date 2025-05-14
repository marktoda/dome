import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { getApiClient } from '../../utils/apiClient';
import { loadConfig } from '../../utils/config';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk'; // SDK imports

// SDK's ChatSource will be used. RelevanceScore is not available.
// interface SourceInfo { ... } // Removed, will use DomeApi.ChatSource

// Type for SDK stream chunks (adapt as needed based on actual stream format)
type SdkChatMessageChunk =
  | { type: 'content' | 'thinking' | 'unknown'; content: string }
  | { type: 'sources'; data: DomeApi.ChatSource[] | DomeApi.ChatSource };

// Chunk detection logic (similar to what was added in commands/chat.ts)
interface ChunkDetector {
  (parsedJson: any): SdkChatMessageChunk | null;
}
const detectors: ChunkDetector[] = [
  (parsed) => {
    if (parsed && parsed.type === 'sources' && parsed.data) {
      return { type: 'sources', data: parsed.data as (DomeApi.ChatSource[] | DomeApi.ChatSource) };
    }
    return null;
  },
  (parsed) => {
    if (parsed && parsed.type === 'thinking' && typeof parsed.content === 'string') {
      return { type: 'thinking', content: parsed.content };
    }
    return null;
  },
  (parsed) => {
    if (parsed && parsed.type === 'content' && typeof parsed.content === 'string') {
      return { type: 'content', content: parsed.content };
    }
    return null;
  },
];

const detectSdkChunk = (jsonData: string): SdkChatMessageChunk => {
  try {
    const parsed = JSON.parse(jsonData);
    for (const det of detectors) {
      const match = det(parsed);
      if (match) return match;
    }
    if (parsed && typeof parsed.content === 'string') {
        return { type: 'content', content: parsed.content };
    }
    if (typeof parsed === 'string') {
        return { type: 'content', content: parsed };
    }
  } catch {
    return { type: 'content', content: jsonData };
  }
  return { type: 'unknown', content: jsonData };
};

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
    let accumulatedSources: DomeApi.ChatSource[] = [];
    const onChunk = (sdkChunk: SdkChatMessageChunk) => {
      if (sdkChunk.type === 'thinking' && !startedContent) {
        convo.thinking = this.thinkingProcessor.process(sdkChunk.content);
      } else if (sdkChunk.type === 'content') {
        if (!startedContent) this.thinkingProcessor.reset();
        convo.reply += sdkChunk.content || '';
        startedContent = true;
      } else if (sdkChunk.type === 'sources') {
        const newSources = Array.isArray(sdkChunk.data) ? sdkChunk.data : [sdkChunk.data];
        accumulatedSources = accumulatedSources.concat(newSources);
        // Sources will be displayed at the end by displaySources
        startedContent = true; // Mark content as started so thinking stops
      } else if (sdkChunk.type === 'unknown') {
        // Similar logic to old unknown handling, adapt if needed
        if (!startedContent) {
          try {
            JSON.parse(sdkChunk.content); // Check if it's JSON that wasn't caught
            convo.thinking = this.thinkingProcessor.process(sdkChunk.content);
          } catch {
            convo.reply += sdkChunk.content || '';
            startedContent = true;
          }
        } else {
          convo.reply += sdkChunk.content || '';
        }
      }
      rebuild();
    };

    /* api call ------------------------------------------------------- */
    try {
      const config = loadConfig();
      if (!config.userId) {
        this.printBlock('{bold}{red-fg}Error:{/red-fg}{/bold}', 'User ID not found. Please login.', cw);
        this.setStatus();
        return;
      }

      const apiClient = await getApiClient();
      // TODO: Integrate ChatSessionManager if TUI chat should persist history across CLI calls
      // For now, sending only the current input as a new conversation.
      const messages: DomeApi.PostChatRequestMessagesItem[] = [{ role: 'user', content: input }];

      const request: DomeApi.PostChatRequest = {
        userId: config.userId,
        messages: messages,
        options: {
          enhanceWithContext: true, // Default options
          maxContextItems: 5,
          includeSourceInfo: true,
          maxTokens: 1000,
          temperature: 0.7,
        },
        stream: true,
      };
      
      const stream = (await apiClient.chat.sendAChatMessage(request)) as any as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) onChunk(detectSdkChunk(buffer.trim()));
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.substring(0, newlineIndex).trim();
          buffer = buffer.substring(newlineIndex + 1);
          if (line) onChunk(detectSdkChunk(line));
        }
      }

      /* sources ------------------------------------------------------ */
      if (accumulatedSources.length > 0) {
        const filteredSources = accumulatedSources.filter((source: DomeApi.ChatSource) => {
          const title = source.title || '';
          return !title.includes('---DOME-METADATA-START---') && !title.match(/^---.*---$/) && title.trim() !== '';
        });
        // No relevanceScore for sorting in DomeApi.ChatSource
        this.displaySources(filteredSources.slice(0, ChatMode.MAX_SOURCES), cw, filteredSources.length);
        this.scrollToBottom();
      }

    } catch (err: unknown) {
      let errorMessage = 'Chat error.';
      if (err instanceof DomeApiError) {
        const apiError = err as DomeApiError;
        errorMessage = `API Error: ${apiError.message} (Status: ${apiError.statusCode || 'N/A'})`;
      } else if (err instanceof DomeApiTimeoutError) {
        const timeoutError = err as DomeApiTimeoutError;
        errorMessage = `API Timeout Error: ${timeoutError.message}`;
      } else if (err instanceof Error) {
        errorMessage = `Chat error: ${err.message}`;
      }
      this.printBlock('{bold}{red-fg}Error:{/red-fg}{/bold}', `I encountered an error: ${errorMessage.slice(0,500)}`, cw);
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

  private displaySources(sources: DomeApi.ChatSource[], cw: number, totalCount?: number): void {
    this.container.pushLine('{bold}Sources:{/bold}');
    sources.forEach((s, i) => {
      const title = s.title ? (s.title.length > 80 ? s.title.slice(0, 80) + '…' : s.title) : 'Unnamed Source';
      this.container.pushLine(`${i + 1}. {underline}${title}{/underline}`);
      this.container.pushLine(`   Type: ${s.type}, ID: ${s.id}`); // Using SDK fields
      if (s.url) {
        this.container.pushLine(`   URL: {blue-fg}${s.url}{/blue-fg}`);
      }
      // Snippet and relevanceScore not available in DomeApi.ChatSource
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

import { Widgets } from 'blessed';
import { BaseMode } from './BaseMode';
import { chat, ChatMessageChunk } from '../../utils/api';

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
        try {
          convo.thinking = JSON.stringify(JSON.parse(chunk.content), null, 2);
        } catch { convo.thinking = chunk.content; }
      } else {
        convo.reply += chunk.content;
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
      if (result?.sources?.length) {
        this.displaySources(result.sources.slice(0, ChatMode.MAX_SOURCES), cw);
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
    if (thinking) this.printBlock('{gray-fg}Thinking:{/gray-fg}', thinking, cw);
    if (thinking || reply) this.printBlock('{bold}{blue-fg}Dome:{/blue-fg}{/bold}', reply, cw);

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

  private displaySources(sources: any[], cw: number): void {
    this.container.pushLine('{bold}Sources:{/bold}');
    sources.forEach((s, i) => {
      const title = s.title?.length > 80 ? s.title.slice(0, 80) + '…' : s.title;
      if (title) this.container.pushLine(`${i + 1}. {underline}${title}{/underline}`);
      if (s.snippet) this.wrapText('   ' + s.snippet.slice(0, 100) + (s.snippet.length > 100 ? '…' : ''), cw);
    });
    if (sources.length > ChatMode.MAX_SOURCES)
      this.container.pushLine(`{italic}(showing ${ChatMode.MAX_SOURCES} of ${sources.length}){/italic}`);
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

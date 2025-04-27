import blessed, { Widgets } from 'blessed';
import { isAuthenticated } from '../../utils/config';
import { error } from '../../utils/ui';
import { ModeManager } from './ModeManager';
import { CommandManager } from './CommandManager';
import { Mode, CommandHandler, TUIContext } from './types';

/* ------------------------------------------------------------------ */
/*  constants & helpers                                               */
/* ------------------------------------------------------------------ */

const SCROLL_STEP = 5;

const keyAliases = {
  down: ['C-j', 'C-J', '\x0A', 'C-n', 'M-j', 'S-down', 'f2'],
  up: ['C-k', 'C-K', '\x0B', 'C-p', 'M-k', 'S-up', 'f1'],
};

/* ------------------------------------------------------------------ */
/*  TUI                                                               */
/* ------------------------------------------------------------------ */

export class TUI {
  private screen: Widgets.Screen;
  private container!: Widgets.BoxElement;
  private sidebar!: Widgets.BoxElement;
  private statusBar!: Widgets.BoxElement;
  private inputBox!: Widgets.TextboxElement;

  private modeManager!: ModeManager;
  private commandManager!: CommandManager;

  private context!: TUIContext;

  constructor() {
    /* authentication ------------------------------------------------- */
    if (!isAuthenticated()) {
      console.log(error('You need to login first. Run `dome login`.'));
      process.exit(1);
    }

    /* screen --------------------------------------------------------- */
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Dome CLI',
      fullUnicode: true,
      cursor: { artificial: true, shape: 'line', blink: true, color: 'cyan' },
      keys: true,
      grabKeys: true,
      dockBorders: true,
      autoPadding: true,
      fastCSR: true,
      terminal: 'xterm-256color',
    });

    this.createLayout();

    /* managers ------------------------------------------------------- */
    this.commandManager = new CommandManager();
    this.modeManager = new ModeManager(
      this.screen,
      this.container,
      this.statusBar,
      this.handleInput,
      this.handleModeChange,
    );

    /* context -------------------------------------------------------- */
    this.context = {
      screen: this.screen,
      container: this.container,
      sidebar: this.sidebar,
      statusBar: this.statusBar,
      inputBox: this.inputBox,
      addMessage: this.addMessage.bind(this),
      setStatus: this.setStatus.bind(this),
      updateSidebar: this.updateSidebar.bind(this),
    };

    /* key bindings & events ----------------------------------------- */
    this.bindKeys();
    this.updateSidebar();
  }

  /* ------------------------------------------------------------------ */
  /*  layout                                                            */
  /* ------------------------------------------------------------------ */

  private createLayout(): void {
    /* header --------------------------------------------------------- */
    blessed.box({
      parent: this.screen,
      top: 0,
      width: '100%',
      height: 1,
      content: '{center}{bold}Dome CLI{/bold}{/center}',
      tags: true,
      style: { fg: 'cyan', bold: true },
    });

    /* sidebar -------------------------------------------------------- */
    this.sidebar = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '30%',
      height: '100%-2',
      border: 'line',
      label: ' Info ',
      padding: { left: 1, right: 1 },
      style: { border: { fg: 'blue' } },
      tags: true,
    });

    /* output container ---------------------------------------------- */
    this.container = blessed.box({
      parent: this.screen,
      top: 1,
      left: '30%',
      width: '70%',
      height: '100%-3',
      border: 'line',
      label: ' Output ',
      padding: { left: 1, right: 1 },
      style: { border: { fg: 'blue' } },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: '█',
        track: { bg: 'black' },
        style: { inverse: true },
      },
    });

    /* status bar ----------------------------------------------------- */
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 1,
      height: 1,
      width: '100%',
      tags: true,
      style: { fg: 'cyan' },
      content: ' {bold}Mode:{/bold} None | /help | Tab focus | Ctrl+C exit',
    });

    /* prompt --------------------------------------------------------- */
    const promptWrapper = blessed.box({
      parent: this.screen,
      bottom: 0,
      height: 3,
      width: '100%',
      border: 'line',
      label: ' Prompt ',
      style: { border: { fg: 'blue' } },
    });

    this.inputBox = blessed.textbox({
      parent: promptWrapper,
      top: 0,
      left: 1,
      height: 1,
      width: '100%-2',
      inputOnFocus: true,
      keys: true,
      mouse: true,
      vi: true,
      style: { fg: 'white', focus: { fg: 'cyan' } },
    });
  }

  /* ------------------------------------------------------------------ */
  /*  key bindings & input                                              */
  /* ------------------------------------------------------------------ */

  private bindKeys(): void {
    const exit = () => {
      this.screen.destroy();
      process.exit(0);
    };

    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);
    this.screen.key(['C-c', 'q'], exit);
    this.inputBox.key(['C-c', 'escape'], exit);

    /* scrolling ------------------------------------------------------ */
    const scroll = (n: number) => {
      this.container.scroll(n);
      this.screen.render();
    };

    [this.screen, this.inputBox, this.container].forEach(el => {
      el.key(keyAliases.down, () => scroll(SCROLL_STEP));
      el.key(keyAliases.up, () => scroll(-SCROLL_STEP));
    });

    this.container.key('j', () => scroll(1));
    this.container.key('k', () => scroll(-1));

    /* focus toggle --------------------------------------------------- */
    this.screen.key('tab', () => {
      (this.screen.focused === this.inputBox ? this.container : this.inputBox).focus();
      this.screen.render();
    });

    /* mode shortcuts ------------------------------------------------- */
    const modeKeys: Record<string, string> = { e: 'explore', n: 'note', t: 'chat' };
    this.screen.key(Object.keys(modeKeys).map(k => `C-${k}`), (_, key) => {
      const id = modeKeys[key.name ?? ''];
      if (id) this.modeManager.switchToMode(id);
    });

    /* submit --------------------------------------------------------- */
    this.inputBox.on('submit', this.onSubmit);
    this.inputBox.focus();
  }

  private onSubmit = async (raw: string): Promise<void> => {
    const input = raw.trim();
    this.inputBox.clearValue();
    this.screen.render();
    if (!input) return;

    try {
      if (input.startsWith('/')) {
        const handled = await this.commandManager.handleCommand(input);
        if (!handled) this.addMessage(`{red-fg}Unknown command ${input}{/red-fg}`);
      } else {
        await this.modeManager.handleInput(input);
      }
    } catch (err) {
      this.addMessage(
        `{red-fg}Error: ${err instanceof Error ? err.message : String(err)}{/red-fg}`,
      );
    } finally {
      this.inputBox.focus();
      this.screen.render();
    }
  };

  /* ------------------------------------------------------------------ */
  /*  UI helpers                                                         */
  /* ------------------------------------------------------------------ */

  private addMessage(msg: string): void {
    this.container.pushLine(msg);
    this.container.setScrollPerc(100);
    this.screen.render();
  }

  private setStatus(msg: string): void {
    this.statusBar.setContent(msg);
    this.screen.render();
  }

  private updateSidebar(): void {
    const active = this.modeManager.getActiveMode();
    let out = '{center}{bold}Dome CLI{/bold}{/center}\n\n';

    /* modes ---------------------------------------------------------- */
    out += '{bold}Modes:{/bold}\n';
    this.modeManager.getAllModes().forEach(m => {
      const cfg = m.getConfig();
      out += `${active === m ? '▶ ' : '  '}{${cfg.color}-fg}${cfg.name}{/${cfg.color}-fg}\n`;
    });

    /* commands ------------------------------------------------------- */
    out += '\n{bold}Commands:{/bold}\n';
    this.commandManager.getAllCommands().forEach(c => {
      out += `  {cyan-fg}/${c.getName()}{/cyan-fg}\n`;
    });

    /* navigation ----------------------------------------------------- */
    out += '\n{bold}Navigation:{/bold}\n';
    out +=
      '  {cyan-fg}Ctrl+j/k{/cyan-fg}, {cyan-fg}Alt+j/k{/cyan-fg}, {cyan-fg}F2/F1{/cyan-fg}\n' +
      '  {cyan-fg}Tab{/cyan-fg} toggle focus | {cyan-fg}j/k{/cyan-fg} scroll when focused\n';

    this.sidebar.setContent(out);
    this.screen.render();
  }

  /* ------------------------------------------------------------------ */
  /*  mode hooks                                                         */
  /* ------------------------------------------------------------------ */

  private handleModeChange = (mode: Mode): void => {
    const cfg = mode.getConfig();
    this.setStatus(` {bold}Mode:{/bold} {${cfg.color}-fg}${cfg.name}{/${cfg.color}-fg} | ${cfg.description}`);
    this.updateSidebar();
  };

  private handleInput = async (input: string): Promise<void> => {
    const active = this.modeManager.getActiveMode();
    if (!active) {
      this.addMessage('{yellow-fg}No active mode. Use /mode <id>.{/yellow-fg}');
      return;
    }
    await active.handleInput(input);
  };

  /* ------------------------------------------------------------------ */
  /*  public API                                                         */
  /* ------------------------------------------------------------------ */

  registerModes(modes: Mode[]): void {
    this.modeManager.registerModes(modes);
    this.modeManager.setupShortcuts();
  }

  registerCommands(cmds: CommandHandler[]): void {
    this.commandManager.registerCommands(cmds);
  }

  start(defaultModeId: string): void {
    this.addMessage('{center}{bold}Welcome to Dome CLI{/bold}{/center}');
    this.addMessage('{center}Type /help for commands{/center}\n');

    if (!this.modeManager.switchToMode(defaultModeId)) {
      this.addMessage(`{red-fg}Error: default mode "${defaultModeId}" not found{/red-fg}`);
    }

    this.screen.render();
  }

  /* getters ---------------------------------------------------------- */
  getContext(): TUIContext { return this.context; }
  getModeManager(): ModeManager { return this.modeManager; }
  getCommandManager(): CommandManager { return this.commandManager; }
}

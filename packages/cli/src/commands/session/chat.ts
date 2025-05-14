import { BaseCommand, CommandArgs } from '../base';
import readline from 'readline';
import chalk from 'chalk';
import { Command } from 'commander';

import { isAuthenticated, loadConfig } from '../../utils/config';
import { ensureValidAccessToken } from '../../utils/auth';
import { heading, info, success, formatDate } from '../../utils/ui';
import { getChatSession, ChatSessionManager } from '../../utils/chatSession';
import { OutputFormat } from '../../utils/errorHandler';
import { getApiBaseUrl } from '../../utils/apiClient';
import { ChatWebSocketClient, ChatMessageChunk } from '../../utils/chatWebSocket';
import { ThinkingIndicator } from '../../utils/indicator';

type StreamOptions = { verbose: boolean; outputFormat: OutputFormat; interactiveRl?: readline.Interface };

async function streamChatResponse(
  userMessage: string,
  opts: StreamOptions,
  session: ChatSessionManager,
  commandInstance: ChatCommand
): Promise<void> {
  // Refresh / validate access token first. This will throw on invalid session.
  let accessToken: string;
  try {
    accessToken = await ensureValidAccessToken();
  } catch (err) {
    commandInstance.error((err as Error).message, { outputFormat: opts.outputFormat });
    return;
  }

  const config = loadConfig();
  if (!config.userId) {
    commandInstance.error('Missing user ID. Please login again.', { outputFormat: opts.outputFormat });
    return;
  }

  session.addUserMessage(userMessage);
  const messages = session.getMessages();

  const indicator = new ThinkingIndicator();
  const baseUrl = getApiBaseUrl();
  const wsProtocol = baseUrl.startsWith('https://') ? 'wss' : 'ws';
  const httpBase = baseUrl.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProtocol}://${httpBase}/chat/ws?token=${accessToken}`;

  if (opts.verbose) {
    console.log(chalk.gray(`[DEBUG] Connecting to WebSocket: ${wsUrl}`));
  }

  const requestPayload = {
    userId: config.userId,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    options: {
      enhanceWithContext: true,
      maxContextItems: 5,
      includeSourceInfo: true,
      maxTokens: 1000,
      temperature: 0.7,
    },
    stream: true,
  };

  const wsClient = new ChatWebSocketClient(wsUrl, requestPayload, { verbose: opts.verbose });

  return new Promise<void>((resolve) => {
    let assistantResponse = '';

    indicator.start();

    wsClient.on('chunk', (chunk: ChatMessageChunk) => {
      switch (chunk.type) {
        case 'thinking':
          // keep spinner running
          break;
        case 'content':
          indicator.stop();
          if (chunk.content) {
            process.stdout.write(chunk.content);
            assistantResponse += chunk.content;
          }
          break;
        case 'sources':
          indicator.stop();
          console.log();
          console.log(chalk.bold.yellow('Sources:'));
          chunk.sources?.forEach((s, i) => {
            console.log(chalk.yellow(`[${i + 1}] ${s.title || 'Untitled'}`));
            console.log(chalk.gray(`    Type: ${s.type}, ID: ${s.id}`));
            if (s.url) console.log(chalk.blue(`    URL: ${s.url}`));
            if (i < (chunk.sources!.length - 1)) console.log();
          });
          console.log();
          break;
        case 'error':
          indicator.stop();
          commandInstance.error(`Chat error: ${chunk.error?.message} (Code: ${chunk.error?.code})`, { outputFormat: opts.outputFormat });
          wsClient.close();
          break;
        case 'end':
          wsClient.close();
          break;
        default:
          // ignore unknown types
          break;
      }
    });

    wsClient.on('error', (err: Error) => {
      indicator.stop();
      commandInstance.error(err.message, { outputFormat: opts.outputFormat });
      resolve();
    });

    wsClient.on('close', () => {
      indicator.stop(chalk.bold.blue('Dome: '));
      if (assistantResponse) {
        session.addAssistantMessage(assistantResponse.trim());
      }
      if (opts.interactiveRl) {
        opts.interactiveRl.prompt();
      }
      resolve();
    });
  });
}

export class ChatCommand extends BaseCommand {
  constructor() {
    super('chat', 'Chat with the RAG-enhanced interface');
  }

  static register(program: Command): void {
    const cmd = program.command('chat')
      .description('Chat with the RAG-enhanced interface')
      .option('-m, --message <message>', 'Send a single message (otherwise start interactive mode)')
      .option('-v, --verbose', 'Enable verbose debug logging')
      .option('-c, --clear', 'Clear chat history before starting')
      .option('-n, --new [sessionName]', 'Start a new chat session with an optional name') // Made sessionName optional for --new
      .option('-s, --session <id>', 'Use a specific session ID')
      .option('-l, --list', 'List available chat sessions')
      .option('--output-format <format>', 'Output format (cli, json)');

    cmd.action(async (optionsFromCommander) => {
      const commandInstance = new ChatCommand();
      // Commander options are directly compatible with CommandArgs
      await commandInstance.executeRun(optionsFromCommander as CommandArgs);
    });
  }

  // `parseArguments` from BaseCommand is not used in this commander flow.

  async run(args: CommandArgs): Promise<void> {
    const outputFormat = args.outputFormat || OutputFormat.CLI;
    const verbose = !!args.verbose;

    if (!isAuthenticated()) {
      this.error('You need to login first. Run `dome login`.', { outputFormat });
      process.exitCode = 1;
      return;
    }

    const shouldCreateNewSession = !args.session && !args.list;
    const session = getChatSession(shouldCreateNewSession);

    if (args.list) {
      this.listSessions(session, outputFormat);
      return;
    }

    if (args.new) {
      session.clearSession(); // Creates a new session ID internally
      const newSessionName = typeof args.new === 'string' ? args.new : `Chat Session ${new Date().toLocaleString()}`;
      session.setSessionName(newSessionName);
      this.log(`Created new session: ${session.getSessionName()}`, outputFormat);
    }

    if (args.session && typeof args.session === 'string') {
      if (session.switchSession(args.session)) {
        this.log(`Switched to session: ${session.getSessionName()}`, outputFormat);
      } else {
        this.error(`Session not found: ${args.session}`, { outputFormat });
        return;
      }
    }

    if (args.clear) {
      session.clearSession();
      this.log('Chat history cleared.', outputFormat);
    }

    const messages = session.getMessages();
    const hasHistory = messages.length > 0;
    const sessionName = session.getSessionName();

    if (args.message && typeof args.message === 'string') {
      if (outputFormat === OutputFormat.CLI) {
        console.log(heading(`Chat: ${sessionName}` + (hasHistory ? ' (with history)' : '')));
        console.log(chalk.bold.green('You: ') + args.message);
        process.stdout.write(chalk.bold.blue('Dome: '));
      }
      
      await streamChatResponse(args.message, { verbose, outputFormat }, session, this);
    } else {
      this.startInteractiveMode(session, verbose, outputFormat);
    }
  }

  private listSessions(session: ChatSessionManager, outputFormat: OutputFormat): void {
    const sessions = session.listSessions();
    if (outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
    }

    if (sessions.length === 0) {
      this.log('No chat sessions available.', outputFormat);
      return;
    }
    console.log(heading('Chat Sessions'));
    const currentSessionId = session.getSessionId();
    sessions.forEach((s, index) => {
      const isActive = s.id === currentSessionId;
      const title = isActive ? chalk.bold.cyan(`${s.name} ${chalk.gray('(active)')}`) : chalk.bold(s.name);
      console.log(`${isActive ? '➤' : ' '} ${chalk.bold.blue(`[${index + 1}]`)} ${title}`);
      console.log(`   ID: ${chalk.gray(s.id)}`);
      console.log(`   Last updated: ${chalk.gray(formatDate(s.lastUpdated))}`);
      console.log(`   Messages: ${chalk.gray(s.messages.length.toString())}`);
      console.log();
    });
  }

  private startInteractiveMode(session: ChatSessionManager, verbose: boolean, outputFormat: OutputFormat): void {
    console.log(heading(`Interactive Chat: ${session.getSessionName()}`));
    console.log(info('Type messages. Special commands: /exit, /clear, /history, /sessions, /new [name], /switch <id|index>, /rename <name>, /delete [id|index]'));
    console.log();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.bold.green('You: '),
    });

    rl.prompt();

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      let promptAfterCommand = true;

      if (trimmed.toLowerCase() === '/exit') {
        this.log('Chat session ended.', outputFormat);
        rl.close();
        return;
      } else if (trimmed.toLowerCase() === '/clear') {
        session.clearSession();
        this.log('Chat history cleared.', outputFormat);
      } else if (trimmed.toLowerCase() === '/history') {
        this.displayHistory(session, outputFormat);
      } else if (trimmed.toLowerCase() === '/sessions') {
        this.listSessions(session, outputFormat);
      } else if (trimmed.toLowerCase().startsWith('/new')) {
        const parts = trimmed.split(' ');
        let name = parts.slice(1).join(' ').trim();
        if (!name) name = `Chat Session ${new Date().toLocaleString()}`;
        session.clearSession(); // Creates new ID
        session.setSessionName(name);
        this.log(`Created new session: ${name}`, outputFormat);
      } else if (trimmed.toLowerCase().startsWith('/switch')) {
        this.handleSwitchCommand(trimmed, session, outputFormat);
      } else if (trimmed.toLowerCase().startsWith('/rename')) {
        const parts = trimmed.split(' ');
        const name = parts.slice(1).join(' ').trim();
        if (!name) this.error('Session name required. Usage: /rename <name>', {outputFormat});
        else {
            session.setSessionName(name);
            this.log(`Renamed session to: ${name}`, outputFormat);
        }
      } else if (trimmed.toLowerCase().startsWith('/delete')) {
        this.handleDeleteCommand(trimmed, session, outputFormat, rl);
        promptAfterCommand = false; // Prompt handled by delete or exit
      } else if (trimmed) {
        console.log(chalk.bold.green('You: ') + trimmed);
        process.stdout.write(chalk.bold.blue('Dome: '));
        
        try {
        await streamChatResponse(trimmed, { verbose, outputFormat, interactiveRl: rl }, session, this);
        } catch (error) {
          console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      
      if (promptAfterCommand) { // Removed !rl.closed check
        rl.prompt();
      }
    });
  }

  private displayHistory(session: ChatSessionManager, outputFormat: OutputFormat): void {
    const historyMessages = session.getMessages();
    if (outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(historyMessages, null, 2));
        return;
    }

    if (historyMessages.length === 0) {
      this.log('No chat history available.', outputFormat);
      return;
    }

    console.log(heading('Chat History'));
    historyMessages.forEach((message, index) => {
      const isUser = message.role === 'user';
      const prefix = isUser ? chalk.bold.green('You: ') : chalk.bold.blue('Dome: ');
      console.log(`${prefix}${message.content}`);
      if (index < historyMessages.length - 1) {
        console.log(); // Add a blank line between messages
      }
    });
    console.log();
  }

  private handleSwitchCommand(command: string, session: ChatSessionManager, outputFormat: OutputFormat): void {
    const parts = command.split(' ');
    const idOrIndex = parts[1]?.trim();
    
    if (!idOrIndex) {
      this.error('Session ID or index required. Usage: /switch <id|index>', { outputFormat });
      return;
    }
    
    // Try to parse as index (1-based for user, 0-based internally)
    const index = parseInt(idOrIndex, 10);
    if (!isNaN(index) && index > 0) {
      const sessions = session.listSessions();
      if (index <= sessions.length) {
        const targetSession = sessions[index - 1];
        if (session.switchSession(targetSession.id)) {
          this.log(`Switched to session: ${session.getSessionName()}`, outputFormat);
        return;
      }
      }
      this.error(`Invalid session index: ${index}`, { outputFormat });
      return;
    }
    
    // Try as direct ID
    if (session.switchSession(idOrIndex)) {
      this.log(`Switched to session: ${session.getSessionName()}`, outputFormat);
    } else {
      this.error(`Session not found: ${idOrIndex}`, { outputFormat });
    }
  }

  private handleDeleteCommand(command: string, session: ChatSessionManager, outputFormat: OutputFormat, rl: readline.Interface): void {
    const parts = command.split(' ');
    const idOrIndex = parts[1]?.trim();
    
    // If no ID/index provided, confirm deletion of current session
    if (!idOrIndex) {
      const currentId = session.getSessionId();
      const currentName = session.getSessionName();
      
      console.log(chalk.yellow(`Are you sure you want to delete the current session "${currentName}"? (y/N)`));
      
      const originalPrompt = rl.getPrompt();
      rl.setPrompt('> ');
                rl.prompt();
      
      const onDeleteLine = (line: string) => {
        const response = line.trim().toLowerCase();
        if (response === 'y' || response === 'yes') {
          if (session.deleteSession(currentId)) {
            this.log(`Deleted session: ${currentName}`, outputFormat);
            // Switch to another session or create new one
            if (session.getSessionId() === currentId) { // If still on deleted session
              this.log('Creating new session...', outputFormat);
            }
          } else {
            this.error('Failed to delete session.', { outputFormat });
          }
        } else {
          this.log('Deletion cancelled.', outputFormat);
        }
        
        rl.setPrompt(originalPrompt);
                rl.prompt();
        rl.removeListener('line', onDeleteLine);
      };
      
      rl.on('line', onDeleteLine);
                return;
            }
    
    // Try to parse as index (1-based for user, 0-based internally)
    const index = parseInt(idOrIndex, 10);
    if (!isNaN(index) && index > 0) {
      const sessions = session.listSessions();
      if (index <= sessions.length) {
        const targetSession = sessions[index - 1];
        if (session.deleteSession(targetSession.id)) {
          this.log(`Deleted session: ${targetSession.name}`, outputFormat);
          rl.prompt();
          return;
        }
      }
      this.error(`Invalid session index: ${index}`, { outputFormat });
      rl.prompt();
      return;
    }
    
    // Try as direct ID
    const sessions = session.listSessions();
    const targetSession = sessions.find(s => s.id === idOrIndex);
    if (targetSession) {
      if (session.deleteSession(idOrIndex)) {
        this.log(`Deleted session: ${targetSession.name}`, outputFormat);
            } else {
        this.error(`Failed to delete session: ${idOrIndex}`, { outputFormat });
            }
        } else {
      this.error(`Session not found: ${idOrIndex}`, { outputFormat });
        }
    
        rl.prompt();
  }
}

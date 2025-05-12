import { BaseCommand, CommandArgs } from '../base';
import readline from 'readline';
import chalk from 'chalk';
import { Command } from 'commander'; // Added import

import { isAuthenticated, loadConfig } from '../../utils/config';
import { heading, info, success, subheading, formatDate } from '../../utils/ui'; // `error` from ui might not be needed if BaseCommand.error is used
import { getChatSession, ChatSessionManager } from '../../utils/chatSession';
import { getApiClient } from '../../utils/apiClient';
import { DomeApi } from '@dome/dome-sdk';
import { OutputFormat } from '../../utils/errorHandler';

// SDK-aligned streaming event types for chat
interface SdkChatContentEvent {
  type: "chat_content";
  text: string;
}

interface SdkChatSourcesEvent {
  type: "chat_sources";
  sources: DomeApi.ChatSource[];
}

interface SdkChatThinkingEvent {
  type: "chat_thinking";
  message: string; // Or status: boolean, to be confirmed by actual SDK stream
}

interface SdkChatMetadataEvent extends DomeApi.StreamingMetadata {
  type: "chat_metadata";
  // Example: could include thinking status if not a separate event
  // thinking?: boolean;
}

interface SdkChatErrorEvent extends DomeApi.StreamingErrorData {
  type: "chat_error";
}

interface SdkUnknownEvent {
    type: "unknown_event";
    data: any;
    originalJson: string;
}

export type SdkStreamingChatEvent =
  | SdkChatContentEvent
  | SdkChatSourcesEvent
  | SdkChatThinkingEvent
  | SdkChatMetadataEvent
  | SdkChatErrorEvent
  | SdkUnknownEvent;


const parseChatStreamEvent = (jsonData: string): SdkStreamingChatEvent => {
  try {
    const parsed = JSON.parse(jsonData);

    if (parsed && typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
      switch (parsed.type) {
        case 'chat_content':
          if (typeof parsed.text === 'string') {
            return parsed as SdkChatContentEvent;
          }
          break;
        case 'chat_sources':
          if (Array.isArray(parsed.sources)) {
            return parsed as SdkChatSourcesEvent;
          }
          break;
        case 'chat_thinking':
          if (typeof parsed.message === 'string') {
            return parsed as SdkChatThinkingEvent;
          }
          break;
        case 'chat_metadata':
          // Basic check, specific StreamingMetadata fields can be validated if needed
          return parsed as SdkChatMetadataEvent;
        case 'chat_error':
          // Basic check, specific StreamingErrorData fields can be validated if needed
          return parsed as SdkChatErrorEvent;
      }
    }
    // Fallback for direct content string or unhandled structured data
    if (typeof parsed === 'string') {
        return { type: 'chat_content', text: parsed };
    }
    if (parsed && typeof parsed.content === 'string') { // Legacy compatibility attempt
        return { type: 'chat_content', text: parsed.content };
    }
    // If it's JSON but doesn't match known types
    return { type: 'unknown_event', data: parsed, originalJson: jsonData };
  } catch (e) {
    // If JSON parsing fails, treat as a simple content string
    return { type: 'chat_content', text: jsonData };
  }
};

type StreamOptions = { verbose: boolean, outputFormat: OutputFormat };

async function streamChatResponse(
  userMessage: string,
  opts: StreamOptions,
  session: ChatSessionManager,
  commandInstance: ChatCommand // Pass the command instance for logging/error handling
): Promise<void> {
  const config = loadConfig();
  if (!config.userId) {
    commandInstance.error('User ID not found. Please login again.', { outputFormat: opts.outputFormat });
    return;
  }

  session.addUserMessage(userMessage);
  const messages = session.getMessages();
  const apiClient = getApiClient();
  let assistantResponse = '';

  try {
    const request: DomeApi.PostChatRequest = {
      userId: config.userId,
      messages: messages.map(m => ({ role: m.role as DomeApi.PostChatRequestMessagesItemRole, content: m.content })),
      options: {
        enhanceWithContext: true,
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
        if (buffer.trim()) {
            const event = parseChatStreamEvent(buffer.trim());
            handleChatStreamEvent(event, opts, commandInstance);
            if (event.type === 'chat_content') assistantResponse += event.text;
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, newlineIndex).trim();
        buffer = buffer.substring(newlineIndex + 1);
        if (line) {
          const event = parseChatStreamEvent(line);
          handleChatStreamEvent(event, opts, commandInstance);
          if (event.type === 'chat_content') assistantResponse += event.text;
        }
      }
    }
  } catch (err: unknown) {
    commandInstance.error(err, { outputFormat: opts.outputFormat });
  } finally {
    if (assistantResponse) {
      session.addAssistantMessage(assistantResponse);
    }
    if (opts.outputFormat === OutputFormat.CLI) {
        console.log(); // Ensure a newline for CLI after the full response or error
    }
  }
}

function handleChatStreamEvent(event: SdkStreamingChatEvent, opts: StreamOptions, commandInstance: ChatCommand) {
    if (opts.outputFormat === OutputFormat.JSON) {
        console.log(JSON.stringify(event));
        return;
    }

    // CLI Output
    switch (event.type) {
        case 'chat_thinking':
            if (opts.verbose && event.message) {
                console.log();
                console.log(chalk.gray('Thinking:'));
                console.log(chalk.gray(event.message));
                console.log();
            }
            break;
        case 'chat_content':
            if (event.text) {
                process.stdout.write(event.text);
            }
            break;
        case 'chat_sources':
            if (event.sources && event.sources.length > 0) {
                console.log(); // Newline before sources
                console.log(chalk.bold.yellow('Sources:'));
                const filteredSources = event.sources.filter(source => {
                    const title = source.title || '';
                    return !title.includes('---DOME-METADATA-START---') && !title.match(/^---.*---$/) && title.trim() !== '';
                });
                filteredSources.forEach((source, index) => {
                    console.log(chalk.yellow(`[${index + 1}] ${source.title || 'Unnamed Source'}`));
                    console.log(chalk.gray(`    Type: ${source.type}, ID: ${source.id}`));
                    if (source.url) console.log(chalk.blue(`    URL: ${source.url}`));
                    if (index < filteredSources.length - 1) console.log();
                });
            }
            break;
        case 'chat_metadata':
            if (opts.verbose) {
                commandInstance.log(chalk.cyan(`[Metadata] Received: ${JSON.stringify(event)}`), opts.outputFormat);
            }
            // Potentially handle thinking indicators if they come via metadata
            // if (event.thinking === true) { console.log(chalk.gray('Thinking...')); }
            // else if (event.thinking === false) { /* Potentially clear thinking message */ }
            break;
        case 'chat_error':
            // Pass the full event as the error object. handleError will process it.
            // The message for CLI will be extracted by handleError if it's a known error type,
            // or a generic message will be used. For JSON, the full event details will be logged.
            commandInstance.error(event, { outputFormat: opts.outputFormat });
            // For CLI, we might still want to log the specific message if available and not handled by default
            if (opts.outputFormat === OutputFormat.CLI) {
                 console.error(chalk.red(`[Stream Error Details] Code: ${event.error.code}, Message: ${event.error.message}`));
            }
            break;
        case 'unknown_event':
            if (opts.verbose) {
                commandInstance.log(chalk.magenta(`[Debug] Received unknown event: ${event.originalJson}`), opts.outputFormat);
            }
            // Attempt to display content if it looks like a simple string was intended
            if (typeof event.data === 'string') {
                process.stdout.write(event.data);
            } else if (event.data && typeof event.data.content === 'string') { // Legacy compatibility
                process.stdout.write(event.data.content);
            }
            break;
    }
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
      return;
    }

    // Interactive REPL (only for CLI output)
    if (outputFormat === OutputFormat.CLI) {
        this.startInteractiveMode(session, verbose, outputFormat);
    } else {
        this.log("Interactive mode is only available for CLI output format. Use --message for JSON output.", outputFormat);
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
        process.stdout.write(chalk.bold.blue('Dome: '));
        await streamChatResponse(trimmed, { verbose, outputFormat }, session, this);
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
      this.log('No chat history.', outputFormat);
    } else {
      console.log(heading('Chat History:'));
      historyMessages.forEach((msg, i) => {
        const role = msg.role === 'user' ? chalk.bold.green('You: ') : chalk.bold.blue('Dome: ');
        console.log(`${role}${msg.content}`);
        if (i < historyMessages.length - 1) console.log();
      });
    }
  }

  private handleSwitchCommand(trimmed: string, session: ChatSessionManager, outputFormat: OutputFormat): void {
    const parts = trimmed.split(' ');
    const sessionIdOrIndex = parts[1]?.trim();
    if (!sessionIdOrIndex) {
      this.error('Session ID or index required. Usage: /switch <id|index>', {outputFormat});
      return;
    }
    if (/^\d+$/.test(sessionIdOrIndex)) {
      const index = parseInt(sessionIdOrIndex, 10);
      const sessions = session.listSessions();
      if (index < 1 || index > sessions.length) {
        this.error(`Invalid session index: ${index}. Valid range: 1-${sessions.length}`, {outputFormat});
        return;
      }
      const targetSessionId = sessions[index - 1].id;
      if (session.switchSession(targetSessionId)) {
        this.log(`Switched to session: ${session.getSessionName()}`, outputFormat);
      } else {
        this.error(`Failed to switch to session at index ${index}`, {outputFormat});
      }
    } else {
      if (session.switchSession(sessionIdOrIndex)) {
        this.log(`Switched to session: ${session.getSessionName()}`, outputFormat);
      } else {
        this.error(`Session not found: ${sessionIdOrIndex}`, {outputFormat});
      }
    }
  }

  private handleDeleteCommand(trimmed: string, session: ChatSessionManager, outputFormat: OutputFormat, rl: readline.Interface): void {
    const parts = trimmed.split(' ');
    const sessionIdOrIndex = parts.length > 1 ? parts.slice(1).join(' ').trim() : null;
    let targetSessionId = session.getSessionId();
    let targetSessionName = session.getSessionName();
    let isCurrentSession = true;

    if (sessionIdOrIndex) {
        isCurrentSession = false;
        if (/^\d+$/.test(sessionIdOrIndex)) {
            const index = parseInt(sessionIdOrIndex, 10);
            const sessions = session.listSessions();
            if (index < 1 || index > sessions.length) {
                this.error(`Invalid session index: ${index}. Valid range: 1-${sessions.length}`, {outputFormat});
                rl.prompt();
                return;
            }
            targetSessionId = sessions[index - 1].id;
            targetSessionName = sessions[index - 1].name;
            if (targetSessionId === session.getSessionId()) isCurrentSession = true;
        } else {
            const foundSession = session.listSessions().find(s => s.id === sessionIdOrIndex || s.name === sessionIdOrIndex);
            if (!foundSession) {
                this.error(`Session not found: ${sessionIdOrIndex}`, {outputFormat});
                rl.prompt();
                return;
            }
            targetSessionId = foundSession.id;
            targetSessionName = foundSession.name;
            if (targetSessionId === session.getSessionId()) isCurrentSession = true;
        }
    }
    
    // Confirmation
    const promptMessage = `Are you sure you want to delete session "${targetSessionName}" (ID: ${targetSessionId})? (yes/no): `;
    rl.question(promptMessage, (answer) => {
        if (answer.trim().toLowerCase() === 'yes') {
            const deleted = session.deleteSession(targetSessionId);
            if (deleted) {
                this.log(`Session "${targetSessionName}" deleted.`, outputFormat);
                if (isCurrentSession) {
                    this.log('Current session was deleted. Starting a new session.', outputFormat);
                    session.clearSession(); // Start a new one
                    session.setSessionName(`Chat Session ${new Date().toLocaleString()}`);
                    this.log(`Active session is now: ${session.getSessionName()}`, outputFormat);
                }
            } else {
                this.error(`Failed to delete session "${targetSessionName}". It might not exist.`, {outputFormat});
            }
        } else {
            this.log('Deletion cancelled.', outputFormat);
        }
        // rl.prompt() is called here to ensure it's called after the async question callback.
        // If rl.close() was called (e.g. in /exit), this prompt might be a no-op or could error
        // depending on readline version and state. It's generally safe to call.
        rl.prompt();
    });
  }
}

// Remove old main test function
// async function main() {
//   const command = new ChatCommand();
//   await command.execute(process.argv.slice(2));
// }

// if (require.main === module) {
//   main();
// }
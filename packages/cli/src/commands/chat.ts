import { Command } from 'commander';
import readline from 'readline';
import chalk from 'chalk';

import { isAuthenticated, loadConfig } from '../utils/config'; // Added loadConfig
import { heading, info, error, success, subheading, formatTable, formatDate } from '../utils/ui';
import { getChatSession, ChatSessionManager } from '../utils/chatSession';
import { getApiClient } from '../utils/apiClient';
import { DomeApi, DomeApiError, DomeApiTimeoutError } from '@dome/dome-sdk'; // SDK imports

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

function fatal(msg: string): never {
  console.log(error(msg));
  process.exit(1);
}

// TODO: Define a type for SDK stream chunks if they are structured, e.g., DomeApi.StreamingChatEvent
// For now, we'll assume chunks are JSON strings that can be parsed into something like the old ChatMessageChunk.
// The old ChatMessageChunk type for reference:
type OldChatMessageChunk =
  | { type: 'content' | 'thinking' | 'unknown'; content: string }
  | {
      type: 'sources';
      node: { // This 'node' structure might differ with the SDK
        sources: DomeApi.ChatSource[] | DomeApi.ChatSource; // Assuming ChatSource is the SDK type for sources
      };
    };


// Extensible chunk‑type detector stack (adapted from old api.ts)
// This will need to be verified against the actual stream format from the SDK.
interface ChunkDetector {
  (parsedJson: any): OldChatMessageChunk | null;
}
const detectors: ChunkDetector[] = [
  // Example: Adapt for SDK's 'sources' event if it's structured differently
  (parsed) => {
    // This is a placeholder. Actual detection logic depends on SDK stream format.
    // For instance, if the SDK sends { type: "sources", data: [...] }
    if (parsed && parsed.type === 'sources' && parsed.data) {
      // Ensure parsed.data matches the expected structure for sources
      // This might involve checking if parsed.data is an array or single object of DomeApi.ChatSource
      return { type: 'sources', node: { sources: parsed.data as (DomeApi.ChatSource[] | DomeApi.ChatSource) } };
    }
    return null;
  },
  // Example: Adapt for SDK's 'thinking' event
  (parsed) => {
    if (parsed && parsed.type === 'thinking' && typeof parsed.content === 'string') {
      return { type: 'thinking', content: parsed.content };
    }
    return null;
  },
  // Example: Adapt for SDK's 'content' event
  (parsed) => {
    if (parsed && parsed.type === 'content' && typeof parsed.content === 'string') {
      return { type: 'content', content: parsed.content };
    }
    return null;
  },
];

const detectSdkChunk = (jsonData: string): OldChatMessageChunk => {
  try {
    const parsed = JSON.parse(jsonData);
    for (const det of detectors) {
      const match = det(parsed);
      if (match) return match;
    }
    // If no specific detector matches, but it's a JSON object with a 'content' string, treat as content
    if (parsed && typeof parsed.content === 'string') {
        return { type: 'content', content: parsed.content };
    }
    // If it's a simple string after parsing (e.g. server sends "raw text chunk" as JSON string literal)
    if (typeof parsed === 'string') {
        return { type: 'content', content: parsed };
    }

  } catch {
    // If JSON.parse fails, it's likely a raw string chunk (or part of one)
    return { type: 'content', content: jsonData }; // Treat non-JSON as content directly
  }
  // Fallback for unparsed or unrecognized JSON
  return { type: 'unknown', content: jsonData };
};


type StreamOptions = { verbose: boolean };

/** Shared streaming printer used by both "single message" and REPL modes. */
async function streamChatResponse(
  userMessage: string, // userMessage is the latest message from the user
  opts: StreamOptions,
  session: ChatSessionManager,
): Promise<void> {
  const config = loadConfig();
  if (!config.userId) {
    console.log(error('User ID not found. Please login again.'));
    return;
  }

  session.addUserMessage(userMessage); // Add user message to session history
  const messages = session.getMessages(); // Get all messages for the request

  const apiClient = getApiClient();
  let assistantResponse = '';

  try {
    const request: DomeApi.PostChatRequest = {
      userId: config.userId,
      messages: messages.map(m => ({ role: m.role as DomeApi.PostChatRequestMessagesItemRole, content: m.content })),
      options: { // Default options, similar to old implementation
        enhanceWithContext: true,
        maxContextItems: 5,
        includeSourceInfo: true,
        maxTokens: 1000,
        temperature: 0.7,
      },
      stream: true, // Enable streaming
    };

    // The actual response type when stream: true might be ReadableStream<Uint8Array>
    // We cast to `any` to handle this, as the .d.ts file shows Promise<DomeApi.ChatSuccessResponse>
    const stream = (await apiClient.chat.sendAChatMessage(request)) as any as ReadableStream<Uint8Array>;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) { // Process any remaining data in the buffer
            const chunk = detectSdkChunk(buffer.trim());
            handleChunk(chunk, opts);
            if (chunk.type === 'content') assistantResponse += chunk.content;
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      
      // Process line by line, assuming NDJSON or similar line-delimited JSON chunks
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.substring(0, newlineIndex).trim();
        buffer = buffer.substring(newlineIndex + 1);
        if (line) {
          const chunk = detectSdkChunk(line);
          handleChunk(chunk, opts);
          if (chunk.type === 'content') assistantResponse += chunk.content;
        }
      }
    }
  } catch (err: unknown) {
    let errorMessage = 'Chat stream failed.';
    if (err instanceof DomeApiError) {
      const apiError = err as DomeApiError;
      const status = apiError.statusCode ?? 'N/A';
      let detailMessage = apiError.message;
       if (apiError.body && typeof apiError.body === 'object' && apiError.body !== null && 'message' in apiError.body && typeof (apiError.body as any).message === 'string') {
        detailMessage = (apiError.body as { message: string }).message;
      }
      errorMessage = `Chat error: ${detailMessage} (Status: ${status})`;
    } else if (err instanceof DomeApiTimeoutError) {
      const timeoutError = err as DomeApiTimeoutError;
      errorMessage = `Chat error: Request timed out. ${timeoutError.message}`;
    } else if (err instanceof Error) {
      errorMessage = `Chat error: ${err.message}`;
    }
    console.error(error(errorMessage));
  } finally {
    if (assistantResponse) {
      session.addAssistantMessage(assistantResponse);
    }
    console.log(); // Ensure a newline after the full response or error
  }
}

// Helper function to process a detected chunk
function handleChunk(chunk: OldChatMessageChunk, opts: StreamOptions) {
    if (chunk.type === 'thinking') {
        if (opts.verbose) { // Only show thinking output in verbose mode
            console.log();
            console.log(chalk.gray('Thinking:'));
            console.log(chalk.gray(chunk.content));
            console.log();
        }
    } else if (chunk.type === 'content') {
        process.stdout.write(chunk.content);
    } else if (chunk.type === 'sources') {
        if (chunk.node.sources) {
            console.log();
            console.log(chalk.bold.yellow('Sources:'));
            
            let sources = Array.isArray(chunk.node.sources)
                ? chunk.node.sources
                : [chunk.node.sources];

            // Filter out metadata and empty titles
            sources = sources.filter(source => {
                const title = source.title || '';
                return (
                    !title.includes('---DOME-METADATA-START---') &&
                    !title.match(/^---.*---$/) &&
                    title.trim() !== ''
                );
            });

            // sources.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0)); // RelevanceScore not available in SDK ChatSource

            sources.forEach((source, index) => {
                console.log(chalk.yellow(`[${index + 1}] ${source.title || 'Unnamed Source'}`));
                // SDK ChatSource has 'type' and 'id', 'url', 'title'
                console.log(chalk.gray(`    Type: ${source.type}, ID: ${source.id}`));
                if (source.url) console.log(chalk.blue(`    URL: ${source.url}`));
                // Relevance score display removed
                if (index < sources.length - 1) console.log();
            });
        }
    } else if (chunk.type === 'unknown') {
        if (opts.verbose) {
            console.debug(chalk.red(`[Debug] Received unknown chunk: ${chunk.content}`));
        }
        // Optionally print unknown chunks if they are not just empty strings or whitespace
        if (chunk.content.trim()) {
             process.stdout.write(chunk.content);
        }
    }
}

/* ------------------------------------------------------------------ */
/*  CLI command                                                       */
/* ------------------------------------------------------------------ */

export function chatCommand(program: Command): void {
  program
    .command('chat')
    .description('Chat with the RAG-enhanced interface')
    .option('-m, --message <message>', 'Send a single message (otherwise start interactive mode)')
    .option('-v, --verbose', 'Enable verbose debug logging')
    .option('-c, --clear', 'Clear chat history before starting')
    .option('-n, --new', 'Start a new chat session')
    .option('-s, --session <id>', 'Use a specific session ID')
    .option('-l, --list', 'List available chat sessions')
    .action(
      async (options: {
        message?: string;
        verbose?: boolean;
        clear?: boolean;
        new?: boolean;
        session?: string;
        list?: boolean;
      }) => {
        if (!isAuthenticated()) fatal('You need to login first. Run `dome login`.');

        const verbose = !!options.verbose;

        // Determine if we should create a new session:
        // - If user explicitly requested a specific session, don't create a new one
        // - If user explicitly requested a new session, create one
        // - Otherwise, create a new session by default for new CLI invocations
        const shouldCreateNewSession = !options.session && !options.list;
        const session = getChatSession(shouldCreateNewSession);

        // List sessions if requested
        if (options.list) {
          const sessions = session.listSessions();
          if (sessions.length === 0) {
            console.log(info('No chat sessions available.'));
            return;
          }

          console.log(heading('Chat Sessions'));

          const currentSessionId = session.getSessionId();
          sessions.forEach((s, index) => {
            const isActive = s.id === currentSessionId;
            const title = isActive
              ? chalk.bold.cyan(`${s.name} ${chalk.gray('(active)')}`)
              : chalk.bold(s.name);

            // Add index number (1-based) to make it easy to reference sessions with /switch
            console.log(`${isActive ? '➤' : ' '} ${chalk.bold.blue(`[${index + 1}]`)} ${title}`);
            console.log(`   ID: ${chalk.gray(s.id)}`);
            console.log(`   Last updated: ${chalk.gray(formatDate(s.lastUpdated))}`);
            console.log(`   Messages: ${chalk.gray(s.messages.length.toString())}`);
            console.log();
          });
          return;
        }

        // Create new session if requested
        if (options.new) {
          session.clearSession();
          console.log(success(`Created new session: ${session.getSessionName()}`));
        }

        // Switch to specific session if requested
        if (options.session) {
          if (session.switchSession(options.session)) {
            console.log(success(`Switched to session: ${session.getSessionName()}`));
          } else {
            console.log(error(`Session not found: ${options.session}`));
            return;
          }
        }

        // Clear history if requested
        if (options.clear) {
          session.clearSession();
          console.log(success('Chat history cleared.'));
        }

        // Show history status
        const messages = session.getMessages();
        const hasHistory = messages.length > 0;
        const sessionId = session.getSessionId();
        const sessionName = session.getSessionName();

        try {
          /* -------- non-interactive -------- */
          if (options.message) {
            console.log(heading(`Chat: ${sessionName}` + (hasHistory ? ' (with history)' : '')));
            console.log(chalk.bold.green('You: ') + options.message);
            process.stdout.write(chalk.bold.blue('Dome: '));
            await streamChatResponse(options.message, { verbose }, session);
            return;
          }

          /* -------- interactive REPL -------- */
          console.log(heading(`Interactive Chat: ${sessionName}`));
          console.log(info('Type messages. Special commands:'));
          console.log(info('  /exit            - Exit the chat'));
          console.log(info('  /clear           - Clear current session history'));
          console.log(info('  /history         - Show message history'));
          console.log(info('  /sessions        - List available sessions'));
          console.log(info('  /new [name]      - Create a new session with optional name'));
          console.log(
            info('  /switch <id|index> - Switch to a different session by ID or index number'),
          );
          console.log(info('  /rename <name>   - Rename current session'));
          console.log(info('  /delete [id]     - Delete current or specified session'));
          console.log();

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: chalk.bold.green('You: '),
          });

          rl.prompt();

          rl.on('line', async line => {
            const trimmed = line.trim();

            // Handle special commands
            if (trimmed === '/exit') {
              console.log(info('Chat session ended.'));
              rl.close();
              return;
            }

            if (trimmed === '/clear') {
              session.clearSession();
              console.log(success('Chat history cleared.'));
              rl.prompt();
              return;
            }

            if (trimmed === '/history') {
              const historyMessages = session.getMessages();
              if (historyMessages.length === 0) {
                console.log(info('No chat history.'));
              } else {
                console.log(heading('Chat History:'));
                historyMessages.forEach((msg, i) => {
                  const role =
                    msg.role === 'user' ? chalk.bold.green('You: ') : chalk.bold.blue('Dome: ');
                  console.log(`${role}${msg.content}`);
                  if (i < historyMessages.length - 1) console.log(); // Add spacing between messages
                });
              }
              rl.prompt();
              return;
            }

            if (trimmed === '/sessions') {
              const sessions = session.listSessions();
              if (sessions.length === 0) {
                console.log(info('No chat sessions available.'));
                rl.prompt();
                return;
              }

              console.log(heading('Chat Sessions'));

              const currentSessionId = session.getSessionId();
              sessions.forEach((s, index) => {
                const isActive = s.id === currentSessionId;
                const title = isActive
                  ? chalk.bold.cyan(`${s.name} ${chalk.gray('(active)')}`)
                  : chalk.bold(s.name);

                // Add index number (1-based) to make it easy to reference sessions with /switch
                console.log(
                  `${isActive ? '➤' : ' '} ${chalk.bold.blue(`[${index + 1}]`)} ${title}`,
                );
                console.log(`   ID: ${chalk.gray(s.id)}`);
                console.log(`   Last updated: ${chalk.gray(formatDate(s.lastUpdated))}`);
                console.log(`   Messages: ${chalk.gray(s.messages.length.toString())}`);
                console.log();
              });

              rl.prompt();
              return;
            }

            if (trimmed.startsWith('/new')) {
              const parts = trimmed.split(' ');
              let name = parts.slice(1).join(' ').trim();

              if (!name) {
                name = `Chat Session ${new Date().toLocaleString()}`;
              }

              session.clearSession();
              session.setSessionName(name);

              console.log(success(`Created new session: ${name}`));
              rl.prompt();
              return;
            }

            if (trimmed.startsWith('/switch')) {
              const parts = trimmed.split(' ');
              const sessionIdOrIndex = parts[1]?.trim();

              if (!sessionIdOrIndex) {
                console.log(error('Session ID or index required. Usage: /switch <id|index>'));
                rl.prompt();
                return;
              }

              // Check if the argument is a number (index)
              if (/^\d+$/.test(sessionIdOrIndex)) {
                const index = parseInt(sessionIdOrIndex, 10);
                const sessions = session.listSessions();

                // Check if the index is valid
                if (index < 1 || index > sessions.length) {
                  console.log(
                    error(`Invalid session index: ${index}. Valid range: 1-${sessions.length}`),
                  );
                  rl.prompt();
                  return;
                }

                // Get the session ID at index-1 (zero-based array)
                const targetSessionId = sessions[index - 1].id;

                if (session.switchSession(targetSessionId)) {
                  console.log(success(`Switched to session: ${session.getSessionName()}`));
                } else {
                  console.log(error(`Failed to switch to session at index ${index}`));
                }
              } else {
                // Treat as a session ID
                if (session.switchSession(sessionIdOrIndex)) {
                  console.log(success(`Switched to session: ${session.getSessionName()}`));
                } else {
                  console.log(error(`Session not found: ${sessionIdOrIndex}`));
                }
              }

              rl.prompt();
              return;
            }

            if (trimmed.startsWith('/rename')) {
              const parts = trimmed.split(' ');
              const name = parts.slice(1).join(' ').trim();

              if (!name) {
                console.log(error('Session name required. Usage: /rename <name>'));
                rl.prompt();
                return;
              }

              session.setSessionName(name);
              console.log(success(`Renamed session to: ${name}`));
              rl.prompt();
              return;
            }

            if (trimmed.startsWith('/delete')) {
              const parts = trimmed.split(' ');
              const sessionId = parts[1]?.trim() || session.getSessionId();

              if (session.deleteSession(sessionId)) {
                console.log(success(`Deleted session: ${sessionId}`));
              } else {
                console.log(error(`Failed to delete session: ${sessionId}`));
              }

              rl.prompt();
              return;
            }

            if (!trimmed) {
              rl.prompt();
              return;
            }

            process.stdout.write(chalk.bold.blue('Dome: '));

            try {
              await streamChatResponse(trimmed, { verbose }, session);
            } catch (err) {
              console.log(error(`Error: ${err instanceof Error ? err.message : String(err)}`));
            }

            rl.prompt();
          });
        } catch (err) {
          fatal(`Failed to chat: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
}

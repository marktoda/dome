import { Command } from 'commander';
import readline from 'readline';
import chalk from 'chalk';

import { chat, ChatMessageChunk } from '../utils/api';
import { isAuthenticated } from '../utils/config';
import { heading, info, error, success } from '../utils/ui';
import { getChatSession } from '../utils/chatSession';

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

function fatal(msg: string): never {
  console.log(error(msg));
  process.exit(1);
}

/** Accumulates stream chunks until a valid JSON object can be parsed. */
class ThinkingBuffer {
  private buf = '';

  tryPush(fragment: string): string {
    this.buf += fragment;
    return this.buf;
  }

  reset(): void {
    this.buf = '';
  }
}

type StreamOptions = { verbose: boolean };

/** Shared streaming printer used by both “single message” and REPL modes. */
async function streamChatResponse(userMessage: string, opts: StreamOptions): Promise<void> {
  const thinking = new ThinkingBuffer();

  await chat(
    userMessage,
    (chunk: ChatMessageChunk | string) => {
      // Handle non-structured responses (should no longer occur after our fix)
      if (typeof chunk === 'string') {
        if (opts.verbose) {
          console.debug('[Debug] Received raw string chunk (unexpected)');
        }
        // process.stdout.write(chunk);
        return;
      }

      // structured chunk
      if (chunk.type === 'thinking') {
        const content = thinking.tryPush(chunk.content);
        if (content) {
          // Only show thinking output in verbose mode
          console.log(); // line break before the block
          console.log(chalk.gray('Thinking:'));
          console.log(chalk.gray(chunk.content));
          console.log(); // trailing blank line
        }
      } else if (chunk.type === 'content') {
        // Prevent duplicate content printing
        process.stdout.write(chunk.content);
      } else if (chunk.type === 'sources') {
        if (chunk.node.sources) {
          console.log(); // Empty line before sources
          console.log(chalk.bold.yellow('Sources:'));

          // Get sources as array and filter out metadata entries
          let sources = Array.isArray(chunk.node.sources)
            ? chunk.node.sources
            : [chunk.node.sources];

          // Filter out metadata entries and other non-displayable sources
          sources = sources.filter(source => {
            const title = source.title || '';
            return (
              !title.includes('---DOME-METADATA-START---') &&
              !title.match(/^---.*---$/) &&
              title.trim() !== ''
            );
          });

          // Sort sources by relevance score (highest first)
          sources.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

          // Display sources with correct numbering
          sources.forEach((source, index) => {
            console.log(chalk.yellow(`[${index + 1}] ${source.title || 'Unnamed Source'}`));
            if (source.source) console.log(chalk.gray(`    Source: ${source.source}`));
            if (source.url) console.log(chalk.blue(`    URL: ${source.url}`));
            if (source.relevanceScore !== undefined) {
              // Format relevance score as percentage
              const scorePercentage = Math.round(source.relevanceScore * 100);
              const scoreColor =
                scorePercentage > 70
                  ? chalk.green
                  : scorePercentage > 40
                  ? chalk.yellow
                  : chalk.red;
              console.log(scoreColor(`    Relevance: ${scorePercentage}%`));
            }
            if (index < sources.length - 1) console.log(); // Add space between sources
          });
        }
      } else {
        // any other content chunk
        thinking.reset(); // discard partial thinking on normal output
        // process.stdout.write(chunk.content); // Uncommented to handle unknown chunk types
      }
    },
    { retryNonStreaming: true, debug: opts.verbose },
  );

  console.log(); // newline after full response
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
    .action(async (options: { message?: string; verbose?: boolean; clear?: boolean }) => {
      if (!isAuthenticated()) fatal('You need to login first. Run `dome login`.');

      const verbose = !!options.verbose;
      const session = getChatSession();
      
      // Clear history if requested
      if (options.clear) {
        session.clearSession();
        console.log(success('Chat history cleared.'));
      }
      
      // Show history status
      const messages = session.getMessages();
      const hasHistory = messages.length > 0;

      try {
        /* -------- non-interactive -------- */
        if (options.message) {
          console.log(heading('Chat' + (hasHistory ? ' (with history)' : '')));
          console.log(chalk.bold.green('You: ') + options.message);
          process.stdout.write(chalk.bold.blue('Dome: '));
          await streamChatResponse(options.message, { verbose });
          return;
        }

        /* -------- interactive REPL -------- */
        console.log(heading('Interactive Chat' + (hasHistory ? ' (with history)' : '')));
        console.log(info('Type messages. Special commands:'));
        console.log(info('  /exit - Exit the chat'));
        console.log(info('  /clear - Clear chat history'));
        console.log(info('  /history - Show message history\n'));

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
                const role = msg.role === 'user' ? chalk.bold.green('You: ') : chalk.bold.blue('Dome: ');
                console.log(`${role}${msg.content}`);
                if (i < historyMessages.length - 1) console.log(); // Add spacing between messages
              });
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
            await streamChatResponse(trimmed, { verbose });
          } catch (err) {
            console.log(error(`Error: ${err instanceof Error ? err.message : String(err)}`));
          }

          rl.prompt();
        });
      } catch (err) {
        fatal(`Failed to chat: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}

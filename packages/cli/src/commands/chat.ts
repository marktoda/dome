import { Command } from 'commander';
import { chat, ChatMessageChunk } from '../utils/api';
import { error, info, heading } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import readline from 'readline';
import chalk from 'chalk';

/**
 * Register the chat command
 * @param program The commander program
 */
export function chatCommand(program: Command): void {
  // Add a buffer for accumulating thinking tokens
  let thinkingBuffer = '';
  program
    .command('chat')
    .description('Chat with the RAG-enhanced interface')
    .option(
      '-m, --message <message>',
      'Single message to send (if not provided, will start interactive mode)',
    )
    .option(
      '-v, --verbose',
      'Enable verbose mode with debug logs',
    )
    .action(async (options: { message?: string; verbose?: boolean }) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        if (options.message) {
          // Send a single message (non-interactive mode)
          console.log(heading('Chat'));
          console.log(chalk.bold.green('You: ') + options.message);
          process.stdout.write(chalk.bold.blue('Dome: '));

          // Stream the response using WebSocket with debug mode based on verbose flag
          const chunks: string[] = [];
          await chat(options.message, (chunk) => {
            // Handle structured chunks or plain strings
            if (typeof chunk === 'string') {
              // Display plain text
              process.stdout.write(chunk);
              chunks.push(chunk);
            } else {
              // Handle structured message chunks
              if (chunk.type === 'thinking') {
                // Accumulate thinking tokens instead of printing each one separately
                if (!thinkingBuffer) {
                  thinkingBuffer = '';
                  // Don't print the thinking header until we have complete JSON
                }
                
                // Add the new token to our buffer
                thinkingBuffer += chunk.content;
                
                try {
                  // Try to parse as JSON to see if we have a complete object
                  const jsonObj = JSON.parse(thinkingBuffer);
                  // Only print if it's valid JSON
                  console.log();
                  console.log(chalk.gray('Thinking:'));
                  console.log(chalk.gray(JSON.stringify(jsonObj, null, 2)));
                  console.log();
                  // Reset buffer after successful display
                  thinkingBuffer = '';
                } catch (e) {
                  // Not valid JSON yet, continue accumulating
                  // Don't print anything until we have a complete thinking step
                }
              } else {
                // Display regular content
                // If we were accumulating thinking content, discard any remaining buffer
                // Since it's incomplete, don't try to display it
                if (thinkingBuffer) {
                  // Just reset the buffer without displaying incomplete thinking
                  thinkingBuffer = '';
                }
                process.stdout.write(chunk.content);
                chunks.push(chunk.content);
              }
            }
          }, { retryNonStreaming: true, debug: options.verbose });
          console.log(); // Add newline after response
        } else {
          // Start interactive chat mode
          console.log(heading('Interactive Chat'));
          console.log(info('Type your messages, one at a time. Type "/exit" to end the chat.'));

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: chalk.bold.green('You: '),
          });

          rl.prompt();

          rl.on('line', async line => {
            if (line.trim() === '/exit') {
              console.log(info('Chat session ended.'));
              rl.close();
              return;
            }

            try {
              const userMessage = line.trim();

              // Display "thinking" indicator
              process.stdout.write(chalk.bold.blue('Dome: '));

              // Use WebSocket streaming with debug mode based on verbose flag
              const chunks: string[] = [];
              await chat(userMessage, (chunk) => {
                // Handle structured chunks or plain strings
                if (typeof chunk === 'string') {
                  // Display plain text
                  process.stdout.write(chunk);
                  chunks.push(chunk);
                } else {
                  // Handle structured message chunks
                  if (chunk.type === 'thinking') {
                    // Accumulate thinking tokens instead of printing each one separately
                    if (!thinkingBuffer) {
                      thinkingBuffer = '';
                      // Don't print the thinking header until we have complete JSON
                    }
                    
                    // Add the new token to our buffer
                    thinkingBuffer += chunk.content;
                    
                    try {
                      // Try to parse as JSON to see if we have a complete object
                      const jsonObj = JSON.parse(thinkingBuffer);
                      // Only print if it's valid JSON
                      console.log();
                      console.log(chalk.gray('Thinking:'));
                      console.log(chalk.gray(JSON.stringify(jsonObj, null, 2)));
                      console.log();
                      // Reset buffer after successful display
                      thinkingBuffer = '';
                    } catch (e) {
                      // Not valid JSON yet, continue accumulating
                      // Don't print anything until we have a complete thinking step
                    }
                  } else {
                    // Display regular content
                    // If we were accumulating thinking content, discard any remaining buffer
                    // Since it's incomplete, don't try to display it
                    if (thinkingBuffer) {
                      // Just reset the buffer without displaying incomplete thinking
                      thinkingBuffer = '';
                    }
                    process.stdout.write(chunk.content);
                    chunks.push(chunk.content);
                  }
                }
              }, { retryNonStreaming: true, debug: options.verbose });
              console.log(); // Add newline after response
            } catch (err) {
              console.log(error(`Error: ${err instanceof Error ? err.message : String(err)}`));
            }

            rl.prompt();
          });
        }
      } catch (err) {
        console.log(error(`Failed to chat: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}

import { Command } from 'commander';
import { chat } from '../utils/api';
import { error, info, heading } from '../utils/ui';
import { isAuthenticated } from '../utils/config';
import readline from 'readline';
import chalk from 'chalk';

/**
 * Register the chat command
 * @param program The commander program
 */
export function chatCommand(program: Command): void {
  program
    .command('chat')
    .description('Chat with the RAG-enhanced interface')
    .option(
      '-m, --message <message>',
      'Single message to send (if not provided, will start interactive mode)',
    )
    .action(async (options: { message?: string }) => {
      // Check if user is authenticated
      if (!isAuthenticated()) {
        console.log(error('You need to login first. Run `dome login` to authenticate.'));
        process.exit(1);
      }

      try {
        if (options.message) {
          // Send a single message
          console.log(heading('Chat'));
          console.log(chalk.bold.green('You: ') + options.message);
          console.log(chalk.bold.blue('Dome: '));

          const response = await chat(options.message);
          console.log(response.message);
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

              const response = await chat(userMessage);
              console.log(response.message);
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

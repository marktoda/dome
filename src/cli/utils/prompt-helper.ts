import inquirer from 'inquirer';
import logger from '../../core/utils/logger.js';

/**
 * Temporarily suppress logger output during inquirer prompts to prevent
 * terminal cursor issues. Returns a restore function.
 */
function suppressLoggerDuringPrompt(): () => void {
  const originalLevel = logger.level;
  const originalWrite = process.stdout.write.bind(process.stdout);

  // Set logger to silent during prompts
  logger.level = 'silent';

  // Also intercept any direct stdout writes from pino-pretty
  (process.stdout as any).write = function (chunk: any, encoding?: any, callback?: any) {
    // Allow inquirer's ANSI escape sequences through
    const str = chunk?.toString() || '';
    if (str.includes('\u001b[') || str === '\n' || str === '\r\n') {
      return originalWrite(chunk, encoding, callback);
    }
    // Block other output during prompts
    return true;
  };

  return () => {
    logger.level = originalLevel;
    (process.stdout as any).write = originalWrite;
  };
}

/**
 * Wrapper around inquirer.prompt that suppresses logger output during prompts
 * to prevent terminal cursor offset issues.
 */
export async function promptWithCleanTerminal<T = any>(
  questions: any,
  initialAnswers?: any
): Promise<T> {
  const restoreLogger = suppressLoggerDuringPrompt();
  try {
    return await inquirer.prompt(questions, initialAnswers);
  } finally {
    restoreLogger();
  }
}

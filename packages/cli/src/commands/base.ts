import { handleError, OutputFormat, HandleErrorOptions } from '../utils/errorHandler';

export interface CommandArgs {
  [key: string]: any;
  outputFormat?: OutputFormat;
}

export abstract class BaseCommand {
  public commandName: string;
  public commandDescription: string;

  constructor(name: string, description: string) {
    this.commandName = name;
    this.commandDescription = description;
  }

  // Abstract method to be implemented by subclasses
  abstract run(args: CommandArgs): Promise<void>;

  // Method to parse arguments (can be extended by subclasses)
  public parseArguments(rawArgs: string[]): CommandArgs {
    // Basic argument parsing, can be replaced with a library like yargs
    const args: CommandArgs = {};
    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg.startsWith('--')) {
        const key = arg.substring(2);
        const nextArg = rawArgs[i + 1];
        if (nextArg && !nextArg.startsWith('--')) {
          if (key === 'output-format' && (nextArg === OutputFormat.JSON || nextArg === OutputFormat.CLI)) {
            args['outputFormat'] = nextArg as OutputFormat;
          } else {
            args[key] = nextArg;
          }
          i++; // Skip next arg as it's a value
        } else {
          args[key] = true; // Flag argument
        }
      }
    }
    return args;
  }

  // Method for standardized output
  public log(message: string, outputFormat: OutputFormat = OutputFormat.CLI): void {
    if (outputFormat === OutputFormat.JSON) {
      // For JSON, we might want to buffer logs and output them as part of a structured response
      // For now, let's just log to console, but ideally this would be more sophisticated
      console.log(JSON.stringify({ message }));
    } else {
      console.log(message);
    }
  }

  // Method for standardized error output, integrating with errorHandler
  public error(
    error: unknown,
    options: HandleErrorOptions = { outputFormat: OutputFormat.CLI }
  ): void {
    handleError(error, options);
  }

  // Central execution method
  public async execute(rawArgs: string[]): Promise<void> {
    try {
      const args = this.parseArguments(rawArgs);
      await this.run(args);
    } catch (e) {
      // Attempt to get outputFormat from parsed args, fallback if parsing fails or not present
      let outputFormat = OutputFormat.CLI;
      try {
        outputFormat = this.parseArguments(rawArgs).outputFormat || OutputFormat.CLI;
      } catch (_) { /* ignore parsing error for error reporting */ }
      this.error(e, { outputFormat });
      process.exitCode = 1;
    }
  }

  /**
   * Executes the command's run method with already parsed arguments (e.g., from Commander)
   * and handles errors.
   */
  public async executeRun(args: CommandArgs): Promise<void> {
    try {
      await this.run(args);
    } catch (e) {
      const outputFormat = args.outputFormat || OutputFormat.CLI;
      this.error(e, { outputFormat });
      process.exitCode = 1;
    }
  }
}
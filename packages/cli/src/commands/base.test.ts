import { describe, it, expect, vi, beforeEach, afterEach, SpyInstance } from 'vitest';
import { BaseCommand, CommandArgs } from './base';
import { OutputFormat } from '../utils/errorHandler';
import * as errorHandlerModule from '../utils/errorHandler'; // Import to spy on handleError

// A concrete implementation of BaseCommand for testing purposes
class TestCommand extends BaseCommand {
  public lastRunArgs: CommandArgs | null = null;

  constructor(name = 'test-cmd', description = 'A test command') {
    super(name, description);
  }

  async run(args: CommandArgs): Promise<void> {
    this.lastRunArgs = args;
    if (args.shouldThrow) {
      throw new Error('Test error in run');
    }
    this.log(`TestCommand executed with: ${JSON.stringify(args)}`, args.outputFormat);
  }
}

describe('BaseCommand', () => {
  let command: TestCommand;
  let consoleLogSpy: SpyInstance;
  let consoleErrorSpy: SpyInstance;
  let handleErrorSpy: SpyInstance;
  let processExitCode: number | undefined;

  beforeEach(() => {
    command = new TestCommand();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    handleErrorSpy = vi.spyOn(errorHandlerModule, 'handleError').mockImplementation(() => {});
    processExitCode = process.exitCode; // Store original
    process.exitCode = 0; // Reset for each test
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    handleErrorSpy.mockRestore();
    process.exitCode = processExitCode; // Restore original
  });

  it('should initialize with name and description', () => {
    expect(command.commandName).toBe('test-cmd');
    expect(command.commandDescription).toBe('A test command');
  });

  describe('parseArguments', () => {
    it('should parse basic arguments', () => {
      const rawArgs = ['--name', 'Dome', '--version', '1.0'];
      const parsed = command.parseArguments(rawArgs);
      expect(parsed).toEqual({ name: 'Dome', version: '1.0' });
    });

    it('should parse flag arguments', () => {
      const rawArgs = ['--verbose', '--force'];
      const parsed = command.parseArguments(rawArgs);
      expect(parsed).toEqual({ verbose: true, force: true });
    });

    it('should parse output-format argument correctly', () => {
      const rawArgsCli = ['--output-format', 'cli'];
      expect(command.parseArguments(rawArgsCli)).toEqual({ outputFormat: OutputFormat.CLI });

      const rawArgsJson = ['--output-format', 'json'];
      expect(command.parseArguments(rawArgsJson)).toEqual({ outputFormat: OutputFormat.JSON });
    });

    it('should ignore invalid output-format values', () => {
      const rawArgs = ['--output-format', 'xml'];
      expect(command.parseArguments(rawArgs)).toEqual({ 'output-format': 'xml' }); // Falls back to generic string
    });

    it('should handle mixed arguments', () => {
      const rawArgs = ['--user', 'root', '--debug', '--output-format', 'json'];
      const parsed = command.parseArguments(rawArgs);
      expect(parsed).toEqual({ user: 'root', debug: true, outputFormat: OutputFormat.JSON });
    });

    it('should handle arguments without values if next is another flag', () => {
      const rawArgs = ['--flag1', '--flag2'];
      const parsed = command.parseArguments(rawArgs);
      expect(parsed).toEqual({ flag1: true, flag2: true });
    });

    it('should handle empty rawArgs', () => {
      expect(command.parseArguments([])).toEqual({});
    });
  });

  describe('log', () => {
    it('should log to console for CLI output', () => {
      command.log('Test message');
      expect(consoleLogSpy).toHaveBeenCalledWith('Test message');
    });

    it('should log JSON string for JSON output', () => {
      command.log('Test message', OutputFormat.JSON);
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ message: 'Test message' }));
    });
  });

  describe('error', () => {
    it('should call handleError with the given error and options', () => {
      const testError = new Error('Something bad happened');
      const options = { outputFormat: OutputFormat.JSON };
      command.error(testError, options);
      expect(handleErrorSpy).toHaveBeenCalledWith(testError, options);
    });

    it('should default to CLI output format if not specified', () => {
      const testError = new Error('Another issue');
      command.error(testError);
      expect(handleErrorSpy).toHaveBeenCalledWith(testError, { outputFormat: OutputFormat.CLI });
    });
  });

  describe('execute', () => {
    it('should parse arguments, call run, and log success', async () => {
      const rawArgs = ['--param', 'value'];
      await command.execute(rawArgs);
      expect(command.lastRunArgs).toEqual({ param: 'value' });
      expect(consoleLogSpy).toHaveBeenCalledWith('TestCommand executed with: {"param":"value"}');
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });

    it('should call error handler and set exit code on run failure', async () => {
      const rawArgs = ['--shouldThrow', 'true'];
      const expectedError = new Error('Test error in run');
      await command.execute(rawArgs);

      expect(command.lastRunArgs).toEqual({ shouldThrow: 'true' }); // run was called
      expect(handleErrorSpy).toHaveBeenCalledWith(expectedError, { outputFormat: OutputFormat.CLI });
      expect(process.exitCode).toBe(1);
    });

    it('should use outputFormat from args for error handling if run fails', async () => {
      const rawArgs = ['--shouldThrow', 'true', '--output-format', 'json'];
      const expectedError = new Error('Test error in run');
      await command.execute(rawArgs);

      expect(handleErrorSpy).toHaveBeenCalledWith(expectedError, { outputFormat: OutputFormat.JSON });
      expect(process.exitCode).toBe(1);
    });

    it('should handle errors during argument parsing', async () => {
        // Sabotage parseArguments for this test
        const parsingError = new Error('Parsing failed');
        vi.spyOn(command, 'parseArguments').mockImplementationOnce(() => {
            throw parsingError;
        });
        const rawArgs = ['--invalid'];
        await command.execute(rawArgs);

        expect(handleErrorSpy).toHaveBeenCalledWith(parsingError, { outputFormat: OutputFormat.CLI });
        expect(process.exitCode).toBe(1);
        expect(command.lastRunArgs).toBeNull(); // run should not have been called
    });
  });

  describe('executeRun', () => {
    it('should call run with provided args and log success', async () => {
      const args = { param: 'value', outputFormat: OutputFormat.JSON };
      await command.executeRun(args);
      expect(command.lastRunArgs).toEqual(args);
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ message: `TestCommand executed with: ${JSON.stringify(args)}` }));
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    });

    it('should call error handler and set exit code on run failure', async () => {
      const args = { shouldThrow: true, outputFormat: OutputFormat.CLI };
      const expectedError = new Error('Test error in run');
      await command.executeRun(args);

      expect(command.lastRunArgs).toEqual(args);
      expect(handleErrorSpy).toHaveBeenCalledWith(expectedError, { outputFormat: OutputFormat.CLI });
      expect(process.exitCode).toBe(1);
    });

    it('should use outputFormat from args for error handling if run fails', async () => {
      const args = { shouldThrow: true, outputFormat: OutputFormat.JSON };
      const expectedError = new Error('Test error in run');
      await command.executeRun(args);

      expect(handleErrorSpy).toHaveBeenCalledWith(expectedError, { outputFormat: OutputFormat.JSON });
      expect(process.exitCode).toBe(1);
    });

     it('should default to CLI output format for errors if not specified in args', async () => {
      const args = { shouldThrow: true }; // No outputFormat
      const expectedError = new Error('Test error in run');
      await command.executeRun(args);

      expect(handleErrorSpy).toHaveBeenCalledWith(expectedError, { outputFormat: OutputFormat.CLI });
      expect(process.exitCode).toBe(1);
    });
  });
});
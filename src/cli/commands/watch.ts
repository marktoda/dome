import { Command } from 'commander';
import { WatcherService } from '../../watcher/WatcherService.js';
import chalk from 'chalk';
import logger from '../../core/utils/logger.js';

export function createWatchCommand(): Command {
  const command = new Command('watch');

  command
    .description('watch vault for changes and process files automatically')
    .option('--no-todos', 'disable todo extraction')
    .option('--no-embeddings', 'disable embedding generation')
    .option('-v, --verbose', 'enable verbose logging')
    .option('-d, --daemon', 'run as daemon (background process)')
    .action(async options => {
      await handleWatch(options);
    });

  return command;
}

async function handleWatch(options: {
  todos: boolean;
  embeddings: boolean;
  verbose?: boolean;
  daemon?: boolean;
}): Promise<void> {
  // Set log level based on verbose flag
  if (options.verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  if (options.daemon) {
    await runAsDaemon(options);
    return;
  }

  // Run in foreground
  console.log(chalk.cyan('🔍 Starting dome watcher'));
  console.log(chalk.gray('Press Ctrl+C to stop\n'));

  const watcher = new WatcherService({
    todos: options.todos,
    embeddings: options.embeddings,
  });

  try {
    await watcher.start();

    // Display status
    const processors = [];
    if (options.todos) processors.push('TODO extraction');
    if (options.embeddings) processors.push('embeddings');

    console.log(chalk.green('✓ Watcher running with:'));
    processors.forEach(p => console.log(chalk.gray(`  • ${p}`)));
    console.log();

    // Keep the process alive
    await new Promise(() => {
      // Process will run until interrupted
    });
  } catch (error) {
    console.error(chalk.red('Failed to start watcher:'), error);
    process.exit(1);
  }
}

async function runAsDaemon(options: { todos: boolean; embeddings: boolean }): Promise<void> {
  const { spawn } = await import('node:child_process');
  console.log(chalk.cyan('Starting watcher daemon...'));

  // Check if daemon is already running
  if (await isDaemonRunning()) {
    console.error(chalk.red('Watcher daemon is already running'));
    console.log(chalk.gray('Use "dome watch:status" to check status'));
    process.exit(1);
  }

  // Spawn detached process
  const child = spawn(
    process.argv[0],
    [
      process.argv[1],
      'watch',
      ...(options.todos ? [] : ['--no-todos']),
      ...(options.embeddings ? [] : ['--no-embeddings']),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        DOME_DAEMON: 'true',
      },
    }
  );

  // Store PID for later management
  await saveDaemonPid(child.pid!);

  child.unref();

  console.log(chalk.green('✓ Watcher daemon started'));
  console.log(chalk.gray(`PID: ${child.pid}`));
  console.log(chalk.gray('Use "dome watch:stop" to stop the daemon'));
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises');
    const pidFile = getPidFilePath();
    const pidStr = await fs.readFile(pidFile, 'utf-8');
    const pid = parseInt(pidStr, 10);

    // Check if process is still running
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function saveDaemonPid(pid: number): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { config } = await import('../../core/utils/config.js');

  const domeDir = path.join(config.DOME_VAULT_PATH, '.dome');
  await fs.mkdir(domeDir, { recursive: true });

  const pidFile = getPidFilePath();
  await fs.writeFile(pidFile, pid.toString());
}

function getPidFilePath(): string {
  const path = require('node:path');
  const { config } = require('../../core/utils/config.js');
  return path.join(config.DOME_VAULT_PATH, '.dome', 'watcher.pid');
}

// Add subcommands for daemon management
export function createWatchStopCommand(): Command {
  const command = new Command('watch:stop');

  command.description('stop the watcher daemon').action(async () => {
    console.log(chalk.cyan('Stopping watcher daemon...'));

    try {
      const fs = await import('node:fs/promises');
      const pidFile = getPidFilePath();
      const pidStr = await fs.readFile(pidFile, 'utf-8');
      const pid = parseInt(pidStr, 10);

      process.kill(pid, 'SIGTERM');
      await fs.unlink(pidFile);

      console.log(chalk.green('✓ Watcher daemon stopped'));
    } catch (error) {
      console.error(chalk.red('Failed to stop daemon (might not be running)'));
    }
  });

  return command;
}

export function createWatchStatusCommand(): Command {
  const command = new Command('watch:status');

  command.description('check watcher daemon status').action(async () => {
    const isRunning = await isDaemonRunning();

    if (isRunning) {
      const fs = await import('node:fs/promises');
      const pidFile = getPidFilePath();
      const pid = await fs.readFile(pidFile, 'utf-8');

      console.log(chalk.green('✓ Watcher daemon is running'));
      console.log(chalk.gray(`  PID: ${pid}`));

      // Try to read state file for more info
      try {
        const path = await import('node:path');
        const { config } = await import('../../core/utils/config.js');
        const stateFile = path.join(config.DOME_VAULT_PATH, '.dome', 'watcher-state.json');
        const stateData = await fs.readFile(stateFile, 'utf-8');
        const state = JSON.parse(stateData);
        const fileCount = Object.keys(state).length;

        console.log(chalk.gray(`  Tracking: ${fileCount} files`));
      } catch {
        // State file might not exist yet
      }
    } else {
      console.log(chalk.yellow('⚠ Watcher daemon is not running'));
      console.log(chalk.gray('Start it with: dome watch --daemon'));
    }
  });

  return command;
}

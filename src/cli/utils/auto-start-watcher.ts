import chalk from 'chalk';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../core/utils/config.js';

async function isDaemonRunning(): Promise<boolean> {
  try {
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

function getPidFilePath(): string {
  return path.join(config.DOME_VAULT_PATH, '.dome', 'watcher.pid');
}

async function saveDaemonPid(pid: number): Promise<void> {
  const domeDir = path.join(config.DOME_VAULT_PATH, '.dome');
  await fs.mkdir(domeDir, { recursive: true });

  const pidFile = getPidFilePath();
  await fs.writeFile(pidFile, pid.toString());
}

async function getAutoStartConfig(): Promise<boolean> {
  try {
    // Check environment variable first
    if (process.env.DOME_AUTO_START_WATCHER === 'false') {
      return false;
    }

    // Check config file
    const configFile = path.join(config.DOME_VAULT_PATH, '.dome', 'config.json');
    const configData = await fs.readFile(configFile, 'utf-8');
    const configJson = JSON.parse(configData);
    return configJson.autoStartWatcher !== false; // Default to true if not specified
  } catch {
    // Default to true if no config exists
    return true;
  }
}

export async function autoStartWatcher(): Promise<void> {
  // Check if auto-start is enabled
  const autoStartEnabled = await getAutoStartConfig();
  if (!autoStartEnabled) {
    return;
  }

  // Check if daemon is already running
  if (await isDaemonRunning()) {
    return;
  }

  // Auto-start the daemon silently
  try {
    const child = spawn(
      process.argv[0],
      [
        process.argv[1],
        'watch',
        '--daemon',
        // Default to enabling both todos and embeddings
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

    // Show a subtle notification
    console.log(chalk.gray('→ Watcher started in background'));
  } catch (error) {
    // Fail silently - don't interrupt the user's command
    console.debug('Failed to auto-start watcher:', error);
  }
}
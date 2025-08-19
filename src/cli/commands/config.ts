import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../core/utils/config.js';

export function createConfigCommand(): Command {
  const command = new Command('config');

  command
    .description('manage dome configuration')
    .option('--auto-start-watcher <boolean>', 'enable/disable auto-starting watcher (true/false)')
    .option('--show', 'show current configuration')
    .action(async options => {
      await handleConfig(options);
    });

  return command;
}

async function handleConfig(options: {
  autoStartWatcher?: string;
  show?: boolean;
}): Promise<void> {
  const configFile = path.join(config.DOME_VAULT_PATH, '.dome', 'config.json');

  // Ensure .dome directory exists
  const domeDir = path.join(config.DOME_VAULT_PATH, '.dome');
  await fs.mkdir(domeDir, { recursive: true });

  // Load existing config or create new one
  let configData: any = {};
  try {
    const existingConfig = await fs.readFile(configFile, 'utf-8');
    configData = JSON.parse(existingConfig);
  } catch {
    // Config doesn't exist yet
  }

  // Show current config if requested
  if (options.show) {
    console.log(chalk.cyan('Current configuration:'));
    console.log(chalk.gray('  Auto-start watcher:'), configData.autoStartWatcher !== false ? 'enabled' : 'disabled');
    return;
  }

  // Update config if options provided
  let updated = false;

  if (options.autoStartWatcher !== undefined) {
    const value = options.autoStartWatcher.toLowerCase() === 'true';
    configData.autoStartWatcher = value;
    updated = true;
    console.log(chalk.green(`✓ Auto-start watcher ${value ? 'enabled' : 'disabled'}`));
  }

  // Save config if updated
  if (updated) {
    await fs.writeFile(configFile, JSON.stringify(configData, null, 2));
    console.log(chalk.gray(`Configuration saved to ${configFile}`));
  } else {
    console.log(chalk.yellow('No configuration changes made'));
    console.log(chalk.gray('Use --show to view current configuration'));
  }
}
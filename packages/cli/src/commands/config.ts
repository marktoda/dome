import { Command } from 'commander';
import { getConfigStore, setBaseUrl, setEnvironment } from '../utils/config';
import { success, error, info, formatKeyValue } from '../utils/ui';

/**
 * Register the config command
 * @param program The commander program
 */
export function configCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage dome CLI configuration');

  // Get configuration
  configCmd
    .command('get')
    .description('Get configuration values')
    .option('-k, --key <key>', 'Specific configuration key to get')
    .action((options: { key?: string }) => {
      try {
        const config = getConfigStore();
        
        if (options.key) {
          // Get specific key
          const value = config.get(options.key);
          
          if (value === undefined) {
            console.log(error(`Configuration key "${options.key}" not found.`));
            return;
          }
          
          console.log(formatKeyValue(options.key, JSON.stringify(value)));
        } else {
          // Get all configuration
          const allConfig = config.store;
          
          console.log(info('Current Configuration:'));
          
          Object.entries(allConfig).forEach(([key, value]) => {
            // Don't show API key directly
            if (key === 'apiKey' && value) {
              console.log(formatKeyValue(key, '********'));
            } else {
              console.log(formatKeyValue(key, JSON.stringify(value)));
            }
          });
        }
      } catch (err) {
        console.log(error(`Failed to get configuration: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // Set configuration
  configCmd
    .command('set')
    .description('Set configuration values')
    .option('-u, --base-url <url>', 'Set the base URL for the API')
    .option('-e, --environment <env>', 'Set the environment (development or production)')
    .action((options: { baseUrl?: string; environment?: string }) => {
      try {
        if (options.baseUrl) {
          // Validate URL
          try {
            new URL(options.baseUrl);
          } catch (err) {
            console.log(error('Invalid URL format.'));
            return;
          }
          
          setBaseUrl(options.baseUrl);
          console.log(success(`Base URL set to: ${options.baseUrl}`));
        }
        
        if (options.environment) {
          // Validate environment
          if (options.environment !== 'development' && options.environment !== 'production') {
            console.log(error('Environment must be either "development" or "production".'));
            return;
          }
          
          setEnvironment(options.environment as 'development' | 'production');
          console.log(success(`Environment set to: ${options.environment}`));
        }
        
        if (!options.baseUrl && !options.environment) {
          console.log(info('No configuration changes specified. Use --base-url or --environment options.'));
        }
      } catch (err) {
        console.log(error(`Failed to set configuration: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });
}
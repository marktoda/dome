import Conf from 'conf';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Define the configuration schema
export interface ConfigSchema {
  apiKey?: string;
  baseUrl: string;
  environment: 'development' | 'production';
}

// Default configuration
const defaultConfig: ConfigSchema = {
  baseUrl: 'http://localhost:8787',
  environment: 'development',
};

// Create the configuration directory if it doesn't exist
const configDir = path.join(os.homedir(), '.config', 'dome');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Create the configuration store
const config = new Conf<ConfigSchema>({
  projectName: 'dome',
  schema: {
    apiKey: {
      type: 'string',
      default: undefined,
    },
    baseUrl: {
      type: 'string',
      default: defaultConfig.baseUrl,
    },
    environment: {
      type: 'string',
      enum: ['development', 'production'],
      default: defaultConfig.environment,
    },
  },
  cwd: configDir,
});

/**
 * Load the configuration
 * @returns The configuration object
 */
export function loadConfig(): ConfigSchema {
  // Check if environment is set via environment variable
  const envFromEnv = process.env.DOME_ENV;
  if (envFromEnv === 'production') {
    config.set('environment', 'production');
    config.set('baseUrl', 'https://api.dome.example.com'); // Replace with actual production URL
  }

  return {
    apiKey: config.get('apiKey'),
    baseUrl: config.get('baseUrl'),
    environment: config.get('environment'),
  };
}

/**
 * Save the API key to the configuration
 * @param apiKey The API key to save
 */
export function saveApiKey(apiKey: string): void {
  config.set('apiKey', apiKey);
}

/**
 * Clear the API key from the configuration
 */
export function clearApiKey(): void {
  config.delete('apiKey');
}

/**
 * Set the base URL
 * @param baseUrl The base URL to set
 */
export function setBaseUrl(baseUrl: string): void {
  config.set('baseUrl', baseUrl);
}

/**
 * Set the environment
 * @param environment The environment to set
 */
export function setEnvironment(environment: 'development' | 'production'): void {
  config.set('environment', environment);
  
  // Update the base URL based on the environment
  if (environment === 'production') {
    config.set('baseUrl', 'https://api.dome.example.com'); // Replace with actual production URL
  } else {
    config.set('baseUrl', defaultConfig.baseUrl);
  }
}

/**
 * Get the configuration store
 * @returns The configuration store
 */
export function getConfigStore(): Conf<ConfigSchema> {
  return config;
}

/**
 * Check if the user is authenticated
 * @returns True if the user is authenticated, false otherwise
 */
export function isAuthenticated(): boolean {
  return !!config.get('apiKey');
}
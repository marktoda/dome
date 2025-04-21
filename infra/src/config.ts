import * as pulumi from '@pulumi/pulumi';

// Configuration for the stack
const config = new pulumi.Config();

// Environment (dev, staging, prod)
export const environment = config.require('environment');

// Common configuration
export const commonConfig = {
  logLevel: config.get('logLevel') || 'info',
  version: config.get('version') || '1.0.0',
};

// Environment-specific configurations
export const environmentConfigs: Record<string, any> = {
  dev: {
    workerSuffix: '-dev',
    observabilityEnabled: true,
    headSamplingRate: 1,
  },
  staging: {
    workerSuffix: '-staging',
    observabilityEnabled: true,
    headSamplingRate: 1,
  },
  prod: {
    workerSuffix: '',
    observabilityEnabled: true,
    headSamplingRate: 1,
  },
};

// Get current environment configuration
export const envConfig = environmentConfigs[environment];

// Resource naming utility
export function resourceName(baseName: string): string {
  return environment === 'prod' ? baseName : `${baseName}${envConfig.workerSuffix}`;
}
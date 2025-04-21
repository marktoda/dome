import { environment, envConfig } from '../config';

/**
 * Generate a resource name with appropriate environment suffix
 * @param baseName The base name of the resource
 * @returns The resource name with environment suffix if not production
 */
export function generateResourceName(baseName: string): string {
  return environment === 'prod' ? baseName : `${baseName}${envConfig.workerSuffix}`;
}

/**
 * Generate a standardized tag object for resources
 * @param resourceType The type of resource
 * @param name The name of the resource
 * @returns A tags object for the resource
 */
export function generateTags(resourceType: string, name: string): Record<string, string> {
  return {
    Name: name,
    Environment: environment,
    ResourceType: resourceType,
    ManagedBy: 'pulumi',
    Project: 'dome',
  };
}
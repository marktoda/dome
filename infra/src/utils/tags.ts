import { environment } from '../config';

/**
 * Standard tags to apply to all resources
 * @returns Object containing standard tags
 */
export function getStandardTags(): Record<string, string> {
  const standardTags: Record<string, string> = {
    Environment: environment,
    ManagedBy: 'pulumi',
    Project: 'dome',
    CreatedAt: new Date().toISOString(),
  };
  
  // Add environment-specific standard tags
  switch (environment) {
    case 'dev':
      standardTags.CostCenter = 'development';
      standardTags.AutoShutdown = 'true';
      break;
    case 'staging':
      standardTags.CostCenter = 'pre-production';
      standardTags.DataClassification = 'internal';
      break;
    case 'prod':
      standardTags.CostCenter = 'production';
      standardTags.DataClassification = 'confidential';
      standardTags.BackupPolicy = 'daily';
      break;
  }
  
  return standardTags;
}

/**
 * Generate resource-specific tags
 * @param resourceType Type of the resource (e.g., 'worker', 'database', 'bucket')
 * @param name Name of the resource
 * @param additionalTags Additional custom tags to add
 * @returns Combined tags object
 */
export function getResourceTags(
  resourceType: string,
  name: string,
  additionalTags: Record<string, string> = {}
): Record<string, string> {
  // Start with standard tags
  const tags = {
    ...getStandardTags(),
    ResourceType: resourceType,
    Name: name,
  };
  
  // Add resource type-specific tags
  const typeTags: Record<string, string> = {};
  
  switch (resourceType) {
    case 'worker':
      typeTags.ServiceType = 'compute';
      typeTags.Runtime = 'cloudflare-workers';
      break;
    case 'database':
      typeTags.ServiceType = 'data';
      typeTags.StorageType = 'structured';
      break;
    case 'bucket':
      typeTags.ServiceType = 'storage';
      typeTags.StorageType = 'object';
      break;
    case 'queue':
      typeTags.ServiceType = 'messaging';
      break;
    case 'vectorize':
      typeTags.ServiceType = 'ai';
      typeTags.StorageType = 'vector';
      break;
  }
  
  // Merge type-specific tags with base tags
  Object.assign(tags, typeTags);
  
  // Add any additional custom tags
  return {
    ...tags,
    ...additionalTags,
  };
}

/**
 * Apply tags to a resource if the resource type supports tagging
 * @param resource The resource to tag
 * @param resourceType Type of the resource
 * @param name Name of the resource
 * @param additionalTags Additional custom tags to add
 * @returns The resource (for chaining)
 */
export function tagResource<T>(
  resource: T,
  resourceType: string,
  name: string,
  additionalTags: Record<string, string> = {}
): T {
  // Get the tags for this resource
  const tags = getResourceTags(resourceType, name, additionalTags);
  
  // Apply tags if the resource has a tags property
  // Note: Currently, Cloudflare resources in Pulumi don't support tags
  // This is a placeholder for when they do
  if (resource && typeof resource === 'object' && 'tags' in resource) {
    (resource as any).tags = tags;
  }
  
  return resource;
}
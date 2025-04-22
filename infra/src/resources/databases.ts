import * as pulumi from '@pulumi/pulumi';
import * as cloudflare from '@pulumi/cloudflare';
import { resourceName } from '../config';
import { getResourceTags, tagResource } from '../utils/tags';

/**
 * Create D1 Databases for the Dome infrastructure
 * @returns Record of D1 Database resources
 */
export function createD1Databases(): Record<string, cloudflare.D1Database> {
  const databases: Record<string, cloudflare.D1Database> = {};

  try {
    // Dome Meta Database
    databases.domeMeta = new cloudflare.D1Database('dome-meta', {
      name: resourceName('dome-meta'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(databases.domeMeta, 'database', 'dome-meta', {
      Purpose: 'metadata-storage',
      Service: 'dome-api,dome-cron',
    });

    // Silo Database
    databases.silo = new cloudflare.D1Database('silo', {
      name: resourceName('silo'),
      // Add tags when Cloudflare provider supports them
    });

    // Apply tags (for future use when Cloudflare supports tagging)
    tagResource(databases.silo, 'database', 'silo', {
      Purpose: 'content-metadata-storage',
      Service: 'silo',
    });

    // Add validation to ensure database names are valid
    for (const [key, database] of Object.entries(databases)) {
      if (!database.name) {
        throw new Error(`Database ${key} has an invalid name`);
      }
    }
  } catch (error) {
    // Handle errors during database creation
    console.error('Error creating D1 databases:', error);
    throw error;
  }

  return databases;
}

/**
 * Export database IDs for reference in other modules
 * @param databases The database resources
 * @returns Record of database IDs
 */
export function getDatabaseIds(
  databases: Record<string, cloudflare.D1Database>,
): Record<string, pulumi.Output<string>> {
  const databaseIds: Record<string, pulumi.Output<string>> = {};

  for (const [key, database] of Object.entries(databases)) {
    databaseIds[key] = database.id;
  }

  return databaseIds;
}

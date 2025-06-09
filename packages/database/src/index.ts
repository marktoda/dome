import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

// Database connection
const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/dome2';
const client = postgres(connectionString);
export const db = drizzle(client, { schema });

// Export all schemas and types
export * from './schema/index.js';

// Export database utilities
export { client };
export type Database = typeof db;

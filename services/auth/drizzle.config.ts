import type { Config } from 'drizzle-kit';

export default {
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
  // Removing d1-http driver config since we don't have the required credentials
  // and only need this for migration generation
  verbose: true,
  strict: true,
} satisfies Config;

import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit config
 * - `dbCredentials` is only used for *generation* time.
 *   For D1 you can point it to the local DB file Wrangler keeps.
 * - `schema` points to the file where you define your tables.
 */
export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  // dbCredentials: {
  //   // Wrangler stores the local sqlite file here:
  //   url: ".wrangler/state/v3/d1/silo/db.sqlite"
  // },
  out: "./migrations"             // SQL migrations will be placed here
} satisfies Config;


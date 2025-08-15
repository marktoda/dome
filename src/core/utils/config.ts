import { z } from 'zod';
import { fileURLToPath } from 'url';
import path from 'path';
import { loadConfigSync } from 'zod-config';
import { envAdapter } from 'zod-config/env-adapter';
import { dotEnvAdapter } from 'zod-config/dotenv-adapter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configSchema = z.object({
  DOME_VAULT_PATH: z.string(),
  DOME_TABLE_NAME: z.string(),
  DOME_INDEX_NAME: z.string(),
  POSTGRES_URI: z.string(),
  OPENAI_API_KEY: z.string().min(1),
});

// using default env (process.env)
export const config = loadConfigSync({
  schema: configSchema,
  adapters: [
    envAdapter({
      customEnv: {
        DOME_VAULT_PATH: `${process.env.HOME}/dome`,
        DOME_TABLE_NAME: 'dome',
        DOME_INDEX_NAME: 'notes_vectors',
        POSTGRES_URI: 'postgres://postgres:password@localhost:5432/dome',
      },
    }),
    envAdapter({ silent: true }),
    dotEnvAdapter({ path: path.join(__dirname, '.env'), silent: true }),
  ],
});

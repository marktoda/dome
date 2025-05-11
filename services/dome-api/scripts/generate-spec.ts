import { generateOpenAPI } from '@hono/zod-openapi';
import app from '../src/index'; // Assuming your Hono app is exported from src/index.ts
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Ensure 'app' is the Hono instance with routes defined using createRoute from @hono/zod-openapi
// If your app instance is structured differently or has multiple parts, you might need to adjust.
// For example, if your routes are in a separate variable that's then used by app.route('/', routes):
// const spec = generateOpenAPI({ routes: yourRoutesObject.getRoutes() }, { ...openapi info... });

const openapiDocument = generateOpenAPI(
  {
    info: {
      title: 'Dome API',
      version: 'v1', // Or read from package.json
    },
    // Add other OpenAPI top-level fields if needed: servers, components, security, tags
  },
  app, // Pass the Hono app instance
);


// Output to the monorepo root directory
const outputPath = path.resolve(__dirname, '../../../openapi.json'); // Adjust if script moves

try {
  writeFileSync(outputPath, JSON.stringify(openapiDocument, null, 2));
  console.log(`OpenAPI spec generated successfully at ${outputPath}`);
} catch (error) {
  console.error('Failed to write OpenAPI spec:', error);
  process.exit(1);
}
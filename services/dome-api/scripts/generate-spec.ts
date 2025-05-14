import { ctx, RequestContext } from '@dome/common/context';
import { baseLogger } from '@dome/common/logging/base';
// No separate import needed for spec generation, it's a method on the app
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Establish a default context for the script execution
const defaultRequestContext: RequestContext = {
  logger: baseLogger, // Use the directly imported baseLogger
  requestId: `generate-spec-${Date.now()}`,
};

// Wrap the main logic in ctx.run
ctx.run(defaultRequestContext, () => {
  const app = require('../src/index').default; // Assuming default export from src/index.ts

  // Call the method on the app instance to get the OpenAPI 3.1 document
  const openapiDocument = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Dome API', // You can customize this
      version: 'v1', // Or read from dome-api's package.json
    },
    // You can add other global OpenAPI fields here if needed, e.g.,
    // servers: [{ url: 'https://api.dome.com/v1' }],
    // components: { securitySchemes: { ... } },
  });

  const outputPath = path.resolve(__dirname, '../../../openapi.json');

  try {
    writeFileSync(outputPath, JSON.stringify(openapiDocument, null, 2));
    console.log(`OpenAPI spec generated successfully at ${outputPath}`);
  } catch (error) {
    console.error('Failed to write OpenAPI spec:', error);
    process.exit(1);
  }
});

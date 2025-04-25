import { AiProcessorClient } from './client';

/**
 * Script to reprocess content with AI processor
 *
 * Usage:
 *   - To reprocess all failed content:
 *     npx ts-node reprocess.ts --userId=<user-id>
 *   - To reprocess a specific content by ID:
 *     npx ts-node reprocess.ts --userId=<user-id> --id=<content-id>
 */
async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const idArg = args.find(arg => arg.startsWith('--id='));
    const userIdArg = args.find(arg => arg.startsWith('--userId='));

    const id = idArg ? idArg.split('=')[1] : undefined;
    const userId = userIdArg ? userIdArg.split('=')[1] : 'test-user-123';

    if (!userId) {
      throw new Error('userId is required. Use --userId=<user-id>');
    }

    console.log({ id, userId }, 'Starting reprocess script');

    // Create a mock binding that calls the API endpoint
    const mockBinding = {
      async reprocess(data: { id?: string; userId: string }): Promise<{
        success: boolean;
        reprocessed: { id: string; success: boolean } | { total: number; successful: number };
      }> {
        // In a real environment, this would be a Cloudflare Worker binding
        // For this script, we'll make a fetch request to the API endpoint
        const apiUrl = 'https://dome-api.chatter-9999.workers.dev';

        // Log the request data for debugging
        console.log('Sending request with data:', data);

        const response = await fetch(`${apiUrl}/ai/reprocess`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-ID': data.userId, // Add userId as a header as well
          },
          body: JSON.stringify(data),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API request failed: ${response.status} ${errorText}`);
        }

        return (await response.json()) as {
          success: boolean;
          reprocessed: { id: string; success: boolean } | { total: number; successful: number };
        };
      },
    };

    // Create the client
    const client = new AiProcessorClient(mockBinding);

    // Call the reprocess method
    const result = await client.reprocess(id ? { id, userId } : { userId });

    // Log the result
    console.log({ result }, 'Reprocess completed');

    // Use type guards to safely access properties
    if (result.reprocessed && 'id' in result.reprocessed) {
      console.log(
        `Reprocessed content ID: ${result.reprocessed.id}, Success: ${result.reprocessed.success}`,
      );
    } else if (
      result.reprocessed &&
      'total' in result.reprocessed &&
      'successful' in result.reprocessed
    ) {
      console.log(
        `Reprocessed ${result.reprocessed.total} items, ${result.reprocessed.successful} successful`,
      );
    } else {
      console.log('Unexpected response format:', result);
    }

    return 0;
  } catch (error) {
    console.log({ error }, 'Error in reprocess script');
    return 1;
  }
}

// Run the script
main()
  .then(exitCode => process.exit(exitCode))
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });

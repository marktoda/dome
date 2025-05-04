/**
 * Example: Using Identity Propagation in Downstream Services
 *
 * This example shows how to use the identity propagation middleware
 * in both HTTP and RPC-based services.
 */
import { Hono } from 'hono';
import {
  createIdentityPropagationMiddleware,
  withIdentityFromRPC,
  addIdentityBaggageHeader,
  getRequestIdentity,
} from '../src/middleware/identityPropagationMiddleware';
import { Identity, getIdentityContext } from '../src/identity';
import { Context, Next } from 'hono';

// ---------------------------------------------------------------------------
// Example 1: HTTP-based service using Hono
// ---------------------------------------------------------------------------

const app = new Hono();

// Apply the identity propagation middleware
// This will extract identity from baggage header or query parameter
app.use(
  '*',
  createIdentityPropagationMiddleware({
    // Optional configuration
    baggageHeaderName: 'baggage', // Default
    baggageParamName: 'baggage', // Default
    requireIdentity: false, // Default (doesn't require identity)
  }),
);

// Example route that uses the identity context
app.get('/user-data', async c => {
  try {
    // Get identity from the request context
    const identity = getRequestIdentity(c);

    if (!identity) {
      return c.json({ error: 'No identity found' }, 401);
    }

    // Use identity in business logic
    const userData = await fetchUserData(identity.uid);

    return c.json({
      message: 'User data retrieved successfully',
      userId: identity.uid,
      organization: identity.org,
      data: userData,
    });
  } catch (error) {
    console.error('Error handling request:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Example route that makes downstream requests with propagated identity
app.get('/documents', async c => {
  // Identity is already available in the AsyncLocalStorage context
  try {
    // Create headers for the downstream request
    const headers = new Headers();

    // Add the identity baggage header (uses current context)
    addIdentityBaggageHeader(headers);

    // Make a request to another service with identity propagation
    const response = await fetch('https://documents-service.example.com/api/list', {
      headers,
    });

    const documents = await response.json();

    return c.json({
      documents,
    });
  } catch (error) {
    console.error('Error fetching documents:', error);
    return c.json({ error: 'Failed to fetch documents' }, 500);
  }
});

// ---------------------------------------------------------------------------
// Example 2: RPC-based service using Cloudflare Workers
// ---------------------------------------------------------------------------

export class DocumentsService {
  // Original RPC method (requires identity to be passed manually)
  async listDocumentsOriginal(userId: string, filters: any): Promise<any[]> {
    // Business logic using userId
    return [
      { id: '1', title: 'Document 1', owner: userId },
      { id: '2', title: 'Document 2', owner: userId },
    ];
  }

  // Wrapped RPC method (extracts identity from baggage parameter)
  listDocuments = withIdentityFromRPC(
    async (filters: any): Promise<any[]> => {
      // Get identity from AsyncLocalStorage context
      try {
        const identity = getIdentityContext();

        // Business logic using identity
        return [
          { id: '1', title: 'Document 1', owner: identity.uid },
          { id: '2', title: 'Document 2', owner: identity.uid },
        ];
      } catch (error) {
        console.error('Error in listDocuments:', error);
        return [];
      }
    },
    {
      requireIdentity: true, // This will throw if no identity is found
    },
  );

  // Another RPC method that doesn't require identity
  searchDocuments = withIdentityFromRPC(
    async (query: string): Promise<any[]> => {
      try {
        const identity = getIdentityContext();
        console.log(`Search requested by user ${identity.uid}`);
      } catch (error) {
        // Identity not available, continue with public search
        console.log('Anonymous search request');
      }

      // Return public documents that match the query
      return [{ id: '5', title: 'Public Document', isPublic: true }];
    },
    {
      requireIdentity: false, // This won't throw if identity is missing
    },
  );
}

// ---------------------------------------------------------------------------
// Example 3: Calling RPC methods with identity propagation
// ---------------------------------------------------------------------------

// Example of how to call an RPC method with identity propagation
async function callDocumentsService() {
  // Get the current identity from context
  try {
    const identity = getIdentityContext();

    // Encode the identity as baggage
    const baggage = encodeIdentityAsBaggage(identity);

    // Create an instance of the service
    const documentsService = new DocumentsService();

    // Call the RPC method with baggage as the last parameter
    const documents = await documentsService.listDocuments({ status: 'active' }, baggage);

    console.log('Documents:', documents);
  } catch (error) {
    console.error('Error calling documents service:', error);
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

// Mock function to fetch user data
async function fetchUserData(userId: string): Promise<any> {
  // In a real implementation, this would make a database query
  return {
    name: 'John Doe',
    email: 'john.doe@example.com',
  };
}

// Import missing function from identity module for the example
function encodeIdentityAsBaggage(identity: Identity): string {
  const parts: string[] = [];

  // Add uid (always required)
  parts.push(`uid=${encodeURIComponent(identity.uid)}`);

  // Add org if present
  if (identity.org) {
    parts.push(`org=${encodeURIComponent(identity.org)}`);
  }

  return parts.join(',');
}

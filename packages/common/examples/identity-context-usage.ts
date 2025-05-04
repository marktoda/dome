/**
 * Example usage of the identity context module
 *
 * This example demonstrates how to use the identity context module
 * in a typical API flow with microservice architecture.
 */
import {
  Identity,
  setIdentityContext,
  getIdentityContext,
  withIdentityContext,
  encodeIdentityAsBaggage,
  decodeIdentityFromBaggage,
} from '../src/identity';

// ======================================================================
// Example 1: API Gateway (Entry Point Service)
// ======================================================================

/**
 * Example API handler in the gateway service.
 * This is where the JWT is validated and the identity context is initially set.
 */
async function apiGatewayHandler(req: Request): Promise<Response> {
  try {
    // 1. Extract and verify JWT (not shown - would use your auth service)
    // const token = req.headers.get('Authorization')?.replace('Bearer ', '');
    // const claims = await verifyJwt(token);

    // For this example, we'll use a mock identity
    const identity: Identity = {
      uid: 'user-123',
      org: 'org-456',
    };

    // 2. Set the identity context for the current request
    return await setIdentityContext(identity, async () => {
      // 3. Process the request using downstream services
      const result = await callDownstreamServices();

      // 4. Return the response
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Example function that calls downstream services.
 * This shows how to propagate the identity context across service boundaries.
 */
async function callDownstreamServices() {
  // 1. Get the current identity context
  const identity = getIdentityContext();

  // 2. Encode the identity as baggage
  const baggage = encodeIdentityAsBaggage(identity);

  // 3. Call a downstream service, passing the baggage
  // In a real application, this would be a service binding or fetch call
  const todosResult = await mockDownstreamServiceCall('/todos', baggage);
  const profileResult = await mockDownstreamServiceCall('/profile', baggage);

  // 4. Return combined results
  return {
    todos: todosResult,
    profile: profileResult,
  };
}

// ======================================================================
// Example 2: Downstream Service
// ======================================================================

/**
 * Example handler in a downstream service.
 * This is where the baggage is received and the identity context is restored.
 */
async function downstreamServiceHandler(req: Request): Promise<Response> {
  try {
    // 1. Extract baggage from request (could be in headers for HTTP or in the RPC parameters)
    const baggage = req.headers.get('baggage') || '';

    // 2. Decode the identity from baggage
    const identity = decodeIdentityFromBaggage(baggage);

    if (!identity) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 3. Set the identity context for this service's processing
    return await withIdentityContext(identity, async () => {
      // 4. Process the request using the identity context
      const path = new URL(req.url).pathname;

      let result;
      if (path === '/todos') {
        result = await getTodosForCurrentUser();
      } else if (path === '/profile') {
        result = await getProfileForCurrentUser();
      } else {
        return new Response('Not Found', { status: 404 });
      }

      // 5. Return the response
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Example function that uses the identity context to get data for the current user.
 */
async function getTodosForCurrentUser() {
  // 1. Get the current identity context
  const identity = getIdentityContext();

  // 2. Use the identity to filter data
  // In a real application, this would query a database
  console.log(
    `Getting todos for user ${identity.uid}${identity.org ? ' in org ' + identity.org : ''}`,
  );

  // 3. Return mock data
  return [
    { id: 1, text: 'Complete auth propagation', completed: false },
    { id: 2, text: 'Review code', completed: true },
  ];
}

/**
 * Another example function that uses the identity context.
 */
async function getProfileForCurrentUser() {
  // 1. Get the current identity context
  const identity = getIdentityContext();

  // 2. Use the identity to get user profile
  console.log(`Getting profile for user ${identity.uid}`);

  // 3. Return mock data
  return {
    uid: identity.uid,
    org: identity.org,
    name: 'Test User',
    email: 'user@example.com',
  };
}

// ======================================================================
// Mock implementations for example purposes
// ======================================================================

/**
 * Mock function to simulate calling a downstream service.
 */
async function mockDownstreamServiceCall(path: string, baggage: string) {
  // Create a mock request
  const req = new Request(`https://example.com${path}`, {
    headers: {
      baggage: baggage,
    },
  });

  // Call the downstream handler
  const response = await downstreamServiceHandler(req);

  // Parse and return the response data
  return await response.json();
}

// Run the example
// In a real application, this would be triggered by incoming requests
async function runExample() {
  console.log('Running identity context example:');

  // Simulate an incoming request
  const req = new Request('https://api.example.com/data', {
    headers: {
      Authorization: 'Bearer mock-jwt-token',
    },
  });

  // Process the request
  const response = await apiGatewayHandler(req);

  // Log the result
  console.log('Response status:', response.status);
  console.log('Response data:', await response.json());
}

// Uncomment to run the example:
// runExample().catch(console.error);

import { Hono } from 'hono';
import { initLogging, getLogger } from '../src';

// Create a Hono app
const app = new Hono();

// Initialize logging middleware
initLogging(app, {
  extraBindings: {
    service: 'example-api',
    version: '1.0.0',
  }
});

// Example service function that uses getLogger
async function fetchUserData(userId: string) {
  const log = getLogger();
  log.debug({ userId }, 'Fetching user data');
  
  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Return mock data
  return {
    id: userId,
    name: 'John Doe',
    email: 'john@example.com'
  };
}

// Routes
app.get('/', (c) => {
  const log = getLogger();
  log.info('Handling root request');
  return c.json({ message: 'Hello World' });
});

app.get('/users/:id', async (c) => {
  const log = getLogger();
  const userId = c.req.param('id');
  
  log.info({ userId }, 'User request received');
  
  try {
    const userData = await fetchUserData(userId);
    log.info({ userId }, 'User data retrieved successfully');
    return c.json(userData);
  } catch (error) {
    log.error(error, 'Failed to retrieve user data');
    return c.json({ error: 'Failed to retrieve user data' }, 500);
  }
});

app.post('/users', async (c) => {
  const log = getLogger();
  
  try {
    const body = await c.req.json();
    log.info({ userData: body }, 'Creating new user');
    
    // Simulate processing
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Log metrics
    log.info({ 
      metric: 'user.creation_time_ms', 
      value: 200 
    }, 'User created');
    
    return c.json({ id: '123', ...body }, 201);
  } catch (error) {
    log.error(error, 'Failed to create user');
    return c.json({ error: 'Failed to create user' }, 400);
  }
});

// Error handling
app.onError((err, c) => {
  const log = getLogger();
  log.error(err, 'Unhandled error in request');
  return c.json({ error: 'Internal Server Error' }, 500);
});

// Export the Hono app
export default app;
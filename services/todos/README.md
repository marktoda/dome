# Todos Service

The Todos service is responsible for managing todo items in the Dome platform. It provides a simple API for creating, retrieving, updating, and deleting todos, as well as querying todos with various filters. The service now includes integration with the AI Processor to automatically extract todos from user notes.

## Key Features

- **AI-Powered Todo Extraction**: Automatically extracts todo items from user notes, integrating with the AI Processor service
- **Comprehensive Todo Management**: Create, retrieve, update, and delete todos with full metadata
- **Flexible Querying**: Filter todos by status, priority, due date, category, and more
- **Statistics**: Get detailed statistics about a user's todos
- **Type-Safe Client**: A fully typed client for easy integration with other services

## AI Integration

The Todos service seamlessly integrates with the AI Processor to:

1. Receive todos extracted from user notes via the todos queue
2. Process these todos with additional metadata (priority, due dates, etc.)
3. Store them in the database for later retrieval

When the AI Processor extracts todos from a note, it sends them to the todos queue, which is then consumed by this service. The todos are processed and stored with their source information, making it possible to trace back to the original note.

## TodosClient

The `TodosClient` is a type-safe client for interacting with the Todos service. It provides methods for all Todos operations and handles error logging, metrics, and validation.

### Installation

To use the TodosClient in another service, you need to add the Todos service as a dependency in your `package.json` file:

```json
{
  "dependencies": {
    "todos": "workspace:*"
  }
}
```

### Usage

Here's how to use the TodosClient in another service:

```typescript
import { createTodosClient, TodosBinding } from 'todos/client';

// Create a TodosClient instance
const todosClient: TodosBinding = createTodosClient(env.TODOS, 'your-service.todos');

// Create a todo
await todosClient.createTodo({
  userId: 'user123',
  title: 'Complete project proposal',
  description: 'Draft the project proposal for the Q3 planning meeting',
  priority: 'high',
  dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000, // 1 week from now
});

// List todos with filtering
const todos = await todosClient.listTodos(
  {
    userId: 'user123',
    status: 'pending',
    priority: 'high',
  },
  { limit: 10 },
);

// Get todo statistics
const stats = await todosClient.stats('user123');
```

### Queue Integration

The Todos service can process messages from different sources:

1. **Direct Todo Jobs**: Messages sent directly to the todos queue with the correct format
2. **AI-Extracted Todos**: Messages from the AI Processor with todos extracted from user notes

For AI-extracted todos, the service transforms the extracted data into proper todo items with all required metadata.

### API Reference

#### `createTodosClient(binding: TodosWorkerBinding, metricsPrefix?: string): TodosBinding`

Creates a new TodosClient instance.

- `binding`: The Cloudflare Worker binding to the Todos service
- `metricsPrefix`: Optional prefix for metrics (defaults to 'todos.client')

#### `TodosBinding` Interface

```typescript
interface TodosBinding {
  createTodo(todo: CreateTodoInput): Promise<CreateTodoResult>;
  getTodo(id: string): Promise<TodoItem | null>;
  listTodos(filter: TodoFilter, pagination?: Pagination): Promise<ListTodosResult>;
  updateTodo(id: string, updates: UpdateTodoInput): Promise<UpdateTodoResult>;
  deleteTodo(id: string): Promise<DeleteTodoResult>;
  batchUpdateTodos(ids: string[], updates: BatchUpdateInput): Promise<BatchUpdateResult>;
  stats(userId: string): Promise<TodoStats>;
}
```

## Architecture

The Todos service is built on Cloudflare Workers with the following components:

1. **Queue Consumer**: Processes todo jobs from the `todos-queue`
2. **RPC Interface**: Provides methods for CRUD operations on todos
3. **Database Layer**: Stores todos in a D1 database

The service integrates with other parts of the Dome platform:

- **Chat Service**: Can create and update todos based on user interactions
- **AI Processor**: Extracts potential todos from notes and sends them to the todos queue
- **Notes Service**: Source of content for potential todos
- **D1 Database**: Stores todo data with comprehensive metadata

## Todo Data Model

Each todo item includes:

- Basic info: title, description, status, priority
- Metadata: category, tags, due dates
- Source tracking: original note, extracted text
- AI enrichment: confidence score, estimated effort, actionable steps

## Workflow

1. **Todo Creation**: Todos can be created directly via RPC or extracted from notes via the queue
2. **Todo Updates**: Services can update todos (mark complete, change priority, etc.)
3. **Todo Queries**: Services can query todos with filtering by status, priority, due date, etc.

## Development

### Setup

1. Clone the repository
2. Install dependencies: `pnpm install`
3. Run local development server: `pnpm dev`

### Testing

Run tests with: `pnpm test`

### Deployment

Deploy to Cloudflare with: `pnpm deploy`

## Benefits of Using TodosClient

- **Type Safety**: The TodosClient provides type-safe methods for all Todos operations
- **Consistent Error Handling**: All methods handle errors consistently and log them with appropriate context
- **Metrics**: All methods track metrics for success, errors, and latency
- **Simplified API**: The TodosClient provides a simplified API for common operations
- **Reduced Code Duplication**: No need to implement the same logic in multiple services
- **Maintainability**: Changes to the Todos API only need to be made in one place

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
| -------- | ----------- | -------- | ------- |
| `VERSION` | Service version | No | `1.0.0` |
| `ENVIRONMENT` | Deployment environment | No | `dev` |
| `LOG_LEVEL` | Logging level | No | `info` |
| `DB` | D1 database for todo storage | Yes | - |

import { unstable_dev } from 'wrangler';
import type { Unstable_DevWorker } from 'wrangler';
// Note: Make sure vitest is installed in the project dependencies
// You may need to run: pnpm add -D vitest
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

// Define response types for type safety
interface TaskResponse {
  success: boolean;
  task: {
    id: string;
    userId: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    dueDate?: number;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
  };
  reminder?: {
    id: string;
    taskId: string;
    remindAt: number;
    delivered: boolean;
    deliveryMethod: string;
    createdAt: number;
  };
}

interface TasksListResponse {
  success: boolean;
  tasks: Array<{
    id: string;
    userId: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    dueDate?: number;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
  }>;
  count: number;
  total: number;
}

interface DeleteResponse {
  success: boolean;
  message: string;
}

interface ErrorResponse {
  success: boolean;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

describe('Tasks API', () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    // Start the worker in development mode
    worker = await unstable_dev('src/index.ts', {
      experimental: { disableExperimentalWarning: true },
      // Use vars for environment variables
      vars: {
        ENVIRONMENT: 'development',
      },
    });
  });

  afterAll(async () => {
    // Stop the worker
    await worker.stop();
  });

  it('should create a task', async () => {
    // Test data
    const taskData = {
      title: 'Test Task',
      description: 'This is a test task',
      priority: 'medium',
      dueDate: Date.now() + 86400000, // Tomorrow
    };

    // Send request to create a task
    const resp = await worker.fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(taskData),
    });

    // Check response
    expect(resp.status).toBe(201);

    // Parse response body with type assertion
    const data = (await resp.json()) as TaskResponse;

    // Validate response
    expect(data.success).toBe(true);
    expect(data.task).toBeDefined();
    expect(data.task.title).toBe(taskData.title);
    expect(data.task.description).toBe(taskData.description);
    expect(data.task.priority).toBe(taskData.priority);
    expect(data.task.userId).toBe('test-user-123');
    expect(data.task.id).toBeDefined();
  });

  it('should list tasks', async () => {
    // Send request to list tasks
    const resp = await worker.fetch('/tasks?userId=test-user-123', {
      method: 'GET',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response
    expect(resp.status).toBe(200);

    // Parse response body with type assertion
    const data = (await resp.json()) as TasksListResponse;

    // Validate response
    expect(data.success).toBe(true);
    expect(data.tasks).toBeDefined();
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it('should get a task by ID', async () => {
    // First create a task
    const taskData = {
      title: 'Another Test Task',
      description: 'This is another test task',
      priority: 'high',
      dueDate: Date.now() + 172800000, // Day after tomorrow
    };

    // Send request to create a task
    const createResp = await worker.fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(taskData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as TaskResponse;
    const taskId = createData.task.id;

    // Send request to get the task
    const getResp = await worker.fetch(`/tasks/${taskId}`, {
      method: 'GET',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response
    expect(getResp.status).toBe(200);

    // Parse response body with type assertion
    const getData = (await getResp.json()) as TaskResponse;

    // Validate response
    expect(getData.success).toBe(true);
    expect(getData.task).toBeDefined();
    expect(getData.task.id).toBe(taskId);
    expect(getData.task.title).toBe(taskData.title);
    expect(getData.task.description).toBe(taskData.description);
    expect(getData.task.priority).toBe(taskData.priority);
  });

  it('should update a task', async () => {
    // First create a task
    const taskData = {
      title: 'Task to Update',
      description: 'This is a task to update',
      priority: 'medium',
    };

    // Send request to create a task
    const createResp = await worker.fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(taskData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as TaskResponse;
    const taskId = createData.task.id;

    // Update data
    const updateData = {
      title: 'Updated Task Title',
      description: 'This task has been updated',
      priority: 'high',
    };

    // Send request to update the task
    const updateResp = await worker.fetch(`/tasks/${taskId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(updateData),
    });

    // Check response
    expect(updateResp.status).toBe(200);

    // Parse response body with type assertion
    const updateResponseData = (await updateResp.json()) as TaskResponse;

    // Validate response
    expect(updateResponseData.success).toBe(true);
    expect(updateResponseData.task).toBeDefined();
    expect(updateResponseData.task.id).toBe(taskId);
    expect(updateResponseData.task.title).toBe(updateData.title);
    expect(updateResponseData.task.description).toBe(updateData.description);
    expect(updateResponseData.task.priority).toBe(updateData.priority);
  });

  it('should complete a task', async () => {
    // First create a task
    const taskData = {
      title: 'Task to Complete',
      description: 'This is a task to complete',
      priority: 'medium',
    };

    // Send request to create a task
    const createResp = await worker.fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(taskData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as TaskResponse;
    const taskId = createData.task.id;

    // Send request to complete the task
    const completeResp = await worker.fetch(`/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response
    expect(completeResp.status).toBe(200);

    // Parse response body with type assertion
    const completeData = (await completeResp.json()) as TaskResponse;

    // Validate response
    expect(completeData.success).toBe(true);
    expect(completeData.task).toBeDefined();
    expect(completeData.task.id).toBe(taskId);
    expect(completeData.task.status).toBe('completed');
    expect(completeData.task.completedAt).toBeDefined();
  });

  it('should delete a task', async () => {
    // First create a task
    const taskData = {
      title: 'Task to Delete',
      description: 'This is a task to delete',
      priority: 'low',
    };

    // Send request to create a task
    const createResp = await worker.fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(taskData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as TaskResponse;
    const taskId = createData.task.id;

    // Send request to delete the task
    const deleteResp = await worker.fetch(`/tasks/${taskId}`, {
      method: 'DELETE',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response
    expect(deleteResp.status).toBe(200);

    // Parse response body with type assertion
    const deleteData = (await deleteResp.json()) as DeleteResponse;

    // Validate response
    expect(deleteData.success).toBe(true);
    expect(deleteData.message).toBeDefined();

    // Try to get the deleted task
    const getResp = await worker.fetch(`/tasks/${taskId}`, {
      method: 'GET',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response - should be 404 Not Found
    expect(getResp.status).toBe(404);
  });

  it('should add a reminder to a task', async () => {
    // First create a task
    const taskData = {
      title: 'Task with Reminder',
      description: 'This is a task with a reminder',
      priority: 'high',
    };

    // Send request to create a task
    const createResp = await worker.fetch('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(taskData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as TaskResponse;
    const taskId = createData.task.id;

    // Reminder data
    const reminderData = {
      remindAt: Date.now() + 3600000, // 1 hour from now
      deliveryMethod: 'email',
    };

    // Send request to add a reminder
    const reminderResp = await worker.fetch(`/tasks/${taskId}/remind`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(reminderData),
    });

    // Check response
    expect(reminderResp.status).toBe(201);

    // Parse response body with type assertion
    const reminderResponseData = (await reminderResp.json()) as { success: boolean; reminder: any };

    // Validate response
    expect(reminderResponseData.success).toBe(true);
    expect(reminderResponseData.reminder).toBeDefined();
    expect(reminderResponseData.reminder.taskId).toBe(taskId);
    expect(reminderResponseData.reminder.remindAt).toBe(reminderData.remindAt);
    expect(reminderResponseData.reminder.deliveryMethod).toBe(reminderData.deliveryMethod);
  });
});

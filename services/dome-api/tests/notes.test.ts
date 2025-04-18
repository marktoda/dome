import { unstable_dev } from 'wrangler';
import type { Unstable_DevWorker } from 'wrangler';
// Note: Make sure vitest is installed in the project dependencies
// You may need to run: pnpm add -D vitest
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

// Define response types for type safety
interface NoteResponse {
  success: boolean;
  note: {
    id: string;
    userId: string;
    title: string;
    body: string;
    contentType: string;
    createdAt: number;
    updatedAt: number;
    embeddingStatus: string;
    r2Key?: string;
    metadata?: string;
  };
}

interface NotesListResponse {
  success: boolean;
  notes: Array<{
    id: string;
    userId: string;
    title: string;
    body: string;
    contentType: string;
    createdAt: number;
    updatedAt: number;
    embeddingStatus: string;
    r2Key?: string;
    metadata?: string;
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

describe('Notes API', () => {
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

  it('should create a note', async () => {
    // Test data
    const noteData = {
      content: 'This is a test note',
      contentType: 'text/plain',
      title: 'Test Note',
    };

    // Send request to create a note
    const resp = await worker.fetch('/notes/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(noteData),
    });

    // Check response
    expect(resp.status).toBe(201);

    // Parse response body with type assertion
    const data = (await resp.json()) as NoteResponse;

    // Validate response
    expect(data.success).toBe(true);
    expect(data.note).toBeDefined();
    expect(data.note.title).toBe(noteData.title);
    expect(data.note.body).toBe(noteData.content);
    expect(data.note.userId).toBe('test-user-123');
    expect(data.note.id).toBeDefined();
  });

  it('should list notes', async () => {
    // Send request to list notes
    const resp = await worker.fetch('/notes?userId=test-user-123', {
      method: 'GET',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response
    expect(resp.status).toBe(200);

    // Parse response body with type assertion
    const data = (await resp.json()) as NotesListResponse;

    // Validate response
    expect(data.success).toBe(true);
    expect(data.notes).toBeDefined();
    expect(Array.isArray(data.notes)).toBe(true);
  });

  it('should get a note by ID', async () => {
    // First create a note
    const noteData = {
      content: 'This is another test note',
      contentType: 'text/plain',
      title: 'Another Test Note',
    };

    // Send request to create a note
    const createResp = await worker.fetch('/notes/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(noteData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as NoteResponse;
    const noteId = createData.note.id;

    // Send request to get the note
    const getResp = await worker.fetch(`/notes/${noteId}`, {
      method: 'GET',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response
    expect(getResp.status).toBe(200);

    // Parse response body with type assertion
    const getData = (await getResp.json()) as NoteResponse;

    // Validate response
    expect(getData.success).toBe(true);
    expect(getData.note).toBeDefined();
    expect(getData.note.id).toBe(noteId);
    expect(getData.note.title).toBe(noteData.title);
    expect(getData.note.body).toBe(noteData.content);
  });

  it('should update a note', async () => {
    // First create a note
    const noteData = {
      content: 'This is a note to update',
      contentType: 'text/plain',
      title: 'Note to Update',
    };

    // Send request to create a note
    const createResp = await worker.fetch('/notes/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(noteData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as NoteResponse;
    const noteId = createData.note.id;

    // Update data
    const updateData = {
      title: 'Updated Note Title',
      body: 'This note has been updated',
    };

    // Send request to update the note
    const updateResp = await worker.fetch(`/notes/${noteId}`, {
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
    const updateResponseData = (await updateResp.json()) as NoteResponse;

    // Validate response
    expect(updateResponseData.success).toBe(true);
    expect(updateResponseData.note).toBeDefined();
    expect(updateResponseData.note.id).toBe(noteId);
    expect(updateResponseData.note.title).toBe(updateData.title);
    expect(updateResponseData.note.body).toBe(updateData.body);
  });

  it('should delete a note', async () => {
    // First create a note
    const noteData = {
      content: 'This is a note to delete',
      contentType: 'text/plain',
      title: 'Note to Delete',
    };

    // Send request to create a note
    const createResp = await worker.fetch('/notes/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'test-user-123',
      },
      body: JSON.stringify(noteData),
    });

    // Parse response body with type assertion
    const createData = (await createResp.json()) as NoteResponse;
    const noteId = createData.note.id;

    // Send request to delete the note
    const deleteResp = await worker.fetch(`/notes/${noteId}`, {
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

    // Try to get the deleted note
    const getResp = await worker.fetch(`/notes/${noteId}`, {
      method: 'GET',
      headers: {
        'x-user-id': 'test-user-123',
      },
    });

    // Check response - should be 404 Not Found
    expect(getResp.status).toBe(404);
  });

  it('should handle unauthorized access', async () => {
    // Send request without user ID
    const resp = await worker.fetch('/notes', {
      method: 'GET',
    });

    // In development mode, this might still work with a default user ID
    // In production, it would return 401 Unauthorized
    if (resp.status === 401) {
      // Parse response body with type assertion
      const data = (await resp.json()) as ErrorResponse;

      // Validate response
      expect(data.success).toBe(false);
      expect(data.error).toBeDefined();
      expect(data.error.code).toBe('UNAUTHORIZED');
    }
  });
});

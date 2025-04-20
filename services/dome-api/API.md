# Dome API Documentation

This document provides comprehensive documentation for all endpoints in the Dome API service.

## Table of Contents

- [Authentication](#authentication)
- [Error Handling](#error-handling)
- [Base URL](#base-url)
- [Endpoints](#endpoints)
  - [Health Check](#health-check)
  - [Notes](#notes)
  - [Search](#search)
  - [Files](#files)
  - [Tasks](#tasks)
  - [Chat](#chat)

## Authentication

All endpoints require authentication via a user ID. This can be provided in one of two ways:

1. Via the `x-user-id` header
2. Via the `userId` query parameter

Example:

```
GET /notes?userId=user-123
```

Or:

```
GET /notes
X-User-Id: user-123
```

## Error Handling

The API uses standard HTTP status codes to indicate the success or failure of requests. In case of an error, the response body will contain a JSON object with the following structure:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {} // Optional additional details
  }
}
```

### Common Error Codes

| Code                    | HTTP Status | Description                             |
| ----------------------- | ----------- | --------------------------------------- |
| `NOT_FOUND`             | 404         | The requested resource was not found    |
| `VALIDATION_ERROR`      | 400         | The request data failed validation      |
| `UNAUTHORIZED`          | 401         | Authentication is required or failed    |
| `INTERNAL_SERVER_ERROR` | 500         | An unexpected error occurred            |
| `EMBEDDING_ERROR`       | 500         | An error occurred during text embedding |
| `SEARCH_ERROR`          | 500         | An error occurred during search         |

## Base URL

All endpoints are relative to the base URL of the deployed Dome API service.

## Endpoints

### Health Check

#### GET /health

Check the health status of the API.

**Response**

```json
{
  "status": "ok",
  "timestamp": "2025-04-19T16:42:38.000Z",
  "service": "dome-api",
  "version": "0.1.0"
}
```

### Notes

#### POST /notes/ingest

Create a new note by ingesting content.

**Request Body**

```json
{
  "content": "This is the content of my note",
  "contentType": "text/plain",
  "title": "My Note Title",
  "metadata": {
    "source": "manual",
    "tags": ["important", "work"]
  },
  "tags": ["important", "work"]
}
```

| Field         | Type   | Required | Description                                                    |
| ------------- | ------ | -------- | -------------------------------------------------------------- |
| `content`     | string | Yes      | The content of the note                                        |
| `contentType` | string | No       | The content type (default: "text/plain")                       |
| `title`       | string | No       | The title of the note (generated from content if not provided) |
| `metadata`    | object | No       | Additional metadata for the note                               |
| `tags`        | array  | No       | Tags for the note                                              |

**Response**

```json
{
  "success": true,
  "note": {
    "id": "note-123",
    "userId": "user-123",
    "title": "My Note Title",
    "body": "This is the content of my note",
    "contentType": "text/plain",
    "metadata": "{\"source\":\"manual\",\"tags\":[\"important\",\"work\"]}",
    "createdAt": 1713634958000,
    "updatedAt": 1713634958000,
    "embeddingStatus": "pending"
  }
}
```

#### GET /notes

List notes for the authenticated user.

**Query Parameters**

| Parameter     | Type   | Required | Description                                     |
| ------------- | ------ | -------- | ----------------------------------------------- |
| `contentType` | string | No       | Filter notes by content type                    |
| `limit`       | number | No       | Maximum number of notes to return (default: 50) |
| `offset`      | number | No       | Number of notes to skip (default: 0)            |

**Response**

```json
{
  "success": true,
  "notes": [
    {
      "id": "note-123",
      "userId": "user-123",
      "title": "My Note Title",
      "body": "This is the content of my note",
      "contentType": "text/plain",
      "metadata": "{\"source\":\"manual\",\"tags\":[\"important\",\"work\"]}",
      "createdAt": 1713634958000,
      "updatedAt": 1713634958000,
      "embeddingStatus": "completed"
    }
    // More notes...
  ],
  "count": 1,
  "total": 1
}
```

#### GET /notes/:id

Get a specific note by ID.

**Path Parameters**

| Parameter | Type   | Description                    |
| --------- | ------ | ------------------------------ |
| `id`      | string | The ID of the note to retrieve |

**Response**

```json
{
  "success": true,
  "note": {
    "id": "note-123",
    "userId": "user-123",
    "title": "My Note Title",
    "body": "This is the content of my note",
    "contentType": "text/plain",
    "metadata": "{\"source\":\"manual\",\"tags\":[\"important\",\"work\"]}",
    "createdAt": 1713634958000,
    "updatedAt": 1713634958000,
    "embeddingStatus": "completed"
  }
}
```

#### PUT /notes/:id

Update a specific note by ID.

**Path Parameters**

| Parameter | Type   | Description                  |
| --------- | ------ | ---------------------------- |
| `id`      | string | The ID of the note to update |

**Request Body**

```json
{
  "title": "Updated Note Title",
  "body": "Updated content of my note",
  "contentType": "text/plain",
  "metadata": {
    "source": "manual",
    "tags": ["important", "work", "updated"]
  }
}
```

**Response**

```json
{
  "success": true,
  "note": {
    "id": "note-123",
    "userId": "user-123",
    "title": "Updated Note Title",
    "body": "Updated content of my note",
    "contentType": "text/plain",
    "metadata": "{\"source\":\"manual\",\"tags\":[\"important\",\"work\",\"updated\"]}",
    "createdAt": 1713634958000,
    "updatedAt": 1713635000000,
    "embeddingStatus": "pending"
  }
}
```

#### DELETE /notes/:id

Delete a specific note by ID.

**Path Parameters**

| Parameter | Type   | Description                  |
| --------- | ------ | ---------------------------- |
| `id`      | string | The ID of the note to delete |

**Response**

```json
{
  "success": true,
  "deleted": true
}
```

### Search

#### GET /notes/search

Search for notes using semantic search.

**Query Parameters**

| Parameter     | Type    | Required | Description                                       |
| ------------- | ------- | -------- | ------------------------------------------------- |
| `q`           | string  | Yes      | The search query (minimum 3 characters)           |
| `limit`       | number  | No       | Maximum number of results to return (default: 10) |
| `offset`      | number  | No       | Number of results to skip (default: 0)            |
| `contentType` | string  | No       | Filter results by content type                    |
| `startDate`   | number  | No       | Filter results by start date (timestamp in ms)    |
| `endDate`     | number  | No       | Filter results by end date (timestamp in ms)      |
| `useCache`    | boolean | No       | Whether to use cached results (default: false)    |

**Response**

```json
{
  "success": true,
  "results": [
    {
      "id": "note-123",
      "userId": "user-123",
      "title": "My Note Title",
      "body": "This is the content of my note",
      "contentType": "text/plain",
      "metadata": "{\"source\":\"manual\",\"tags\":[\"important\",\"work\"]}",
      "createdAt": 1713634958000,
      "updatedAt": 1713634958000,
      "score": 0.92,
      "embeddingStatus": "completed"
    }
    // More results...
  ],
  "pagination": {
    "total": 1,
    "limit": 10,
    "offset": 0,
    "hasMore": false
  },
  "query": "search query"
}
```

#### GET /notes/search/stream

Stream search results as NDJSON (Newline Delimited JSON).

**Query Parameters**

Same as `GET /notes/search`.

**Response**

The response is a stream of NDJSON objects, each on a new line:

```
{"type":"metadata","pagination":{"total":1,"limit":10,"offset":0,"hasMore":false},"query":"search query"}
{"type":"result","data":{"id":"note-123","userId":"user-123","title":"My Note Title","body":"This is the content of my note","contentType":"text/plain","metadata":"{\"source\":\"manual\",\"tags\":[\"important\",\"work\"]}","createdAt":1713634958000,"updatedAt":1713634958000,"score":0.92,"embeddingStatus":"completed"}}
```

### Files

#### POST /notes/files

Upload a file and create a note with it.

**Request Body**

Multipart form data with the following fields:

| Field   | Type   | Required | Description            |
| ------- | ------ | -------- | ---------------------- |
| `file`  | File   | Yes      | The file to upload     |
| `title` | string | Yes      | The title for the note |

**Response**

```json
{
  "note": {
    "id": "note-456",
    "userId": "user-123",
    "title": "My File Note",
    "body": "",
    "contentType": "application/pdf",
    "r2Key": "user-123/note-456.pdf",
    "metadata": null,
    "createdAt": 1713634958000,
    "updatedAt": 1713634958000,
    "embeddingStatus": "pending"
  }
}
```

#### GET /notes/:id/file

Get a file attachment for a note.

**Path Parameters**

| Parameter | Type   | Description        |
| --------- | ------ | ------------------ |
| `id`      | string | The ID of the note |

**Response**

The file content with the appropriate content type header.

#### POST /notes/:id/process-file

Process the content of a file attachment.

**Path Parameters**

| Parameter | Type   | Description        |
| --------- | ------ | ------------------ |
| `id`      | string | The ID of the note |

**Response**

```json
{
  "note": {
    "id": "note-456",
    "userId": "user-123",
    "title": "My File Note",
    "body": "Extracted content from the file...",
    "contentType": "application/pdf",
    "r2Key": "user-123/note-456.pdf",
    "metadata": null,
    "createdAt": 1713634958000,
    "updatedAt": 1713635100000,
    "embeddingStatus": "pending"
  }
}
```

#### DELETE /notes/:id/file

Delete a file attachment.

**Path Parameters**

| Parameter | Type   | Description        |
| --------- | ------ | ------------------ |
| `id`      | string | The ID of the note |

**Response**

```json
{
  "success": true
}
```

### Tasks

#### POST /tasks

Create a new task.

**Request Body**

```json
{
  "title": "My Task",
  "description": "This is a task description",
  "priority": "high",
  "dueDate": 1713720000000,
  "reminderTime": 1713710000000,
  "deliveryMethod": "email"
}
```

| Field            | Type   | Required | Description                                          |
| ---------------- | ------ | -------- | ---------------------------------------------------- |
| `title`          | string | Yes      | The title of the task                                |
| `description`    | string | No       | The description of the task                          |
| `priority`       | string | No       | The priority of the task (low, medium, high, urgent) |
| `dueDate`        | number | No       | The due date of the task (timestamp in ms)           |
| `reminderTime`   | number | No       | When to send a reminder (timestamp in ms)            |
| `deliveryMethod` | string | No       | How to deliver the reminder (email, push, sms)       |

**Response**

```json
{
  "success": true,
  "task": {
    "id": "task-123",
    "userId": "user-123",
    "title": "My Task",
    "description": "This is a task description",
    "status": "pending",
    "priority": "high",
    "dueDate": 1713720000000,
    "createdAt": 1713634958000,
    "updatedAt": 1713634958000,
    "completedAt": null
  },
  "reminder": {
    "id": "reminder-123",
    "taskId": "task-123",
    "remindAt": 1713710000000,
    "delivered": false,
    "deliveryMethod": "email",
    "createdAt": 1713634958000
  }
}
```

#### GET /tasks

List tasks for the authenticated user.

**Query Parameters**

| Parameter  | Type   | Required | Description                                          |
| ---------- | ------ | -------- | ---------------------------------------------------- |
| `status`   | string | No       | Filter tasks by status (pending, completed)          |
| `priority` | string | No       | Filter tasks by priority (low, medium, high, urgent) |
| `dueDate`  | number | No       | Filter tasks due before this date (timestamp in ms)  |
| `limit`    | number | No       | Maximum number of tasks to return (default: 50)      |
| `offset`   | number | No       | Number of tasks to skip (default: 0)                 |

**Response**

```json
{
  "success": true,
  "tasks": [
    {
      "id": "task-123",
      "userId": "user-123",
      "title": "My Task",
      "description": "This is a task description",
      "status": "pending",
      "priority": "high",
      "dueDate": 1713720000000,
      "createdAt": 1713634958000,
      "updatedAt": 1713634958000,
      "completedAt": null
    }
    // More tasks...
  ],
  "count": 1,
  "total": 1
}
```

#### GET /tasks/:id

Get a specific task by ID.

**Path Parameters**

| Parameter | Type   | Description                    |
| --------- | ------ | ------------------------------ |
| `id`      | string | The ID of the task to retrieve |

**Response**

```json
{
  "success": true,
  "task": {
    "id": "task-123",
    "userId": "user-123",
    "title": "My Task",
    "description": "This is a task description",
    "status": "pending",
    "priority": "high",
    "dueDate": 1713720000000,
    "createdAt": 1713634958000,
    "updatedAt": 1713634958000,
    "completedAt": null
  },
  "reminders": [
    {
      "id": "reminder-123",
      "taskId": "task-123",
      "remindAt": 1713710000000,
      "delivered": false,
      "deliveryMethod": "email",
      "createdAt": 1713634958000
    }
  ]
}
```

#### PUT /tasks/:id

Update a specific task by ID.

**Path Parameters**

| Parameter | Type   | Description                  |
| --------- | ------ | ---------------------------- |
| `id`      | string | The ID of the task to update |

**Request Body**

```json
{
  "title": "Updated Task",
  "description": "Updated task description",
  "priority": "urgent",
  "dueDate": 1713730000000,
  "reminderTime": 1713720000000,
  "deliveryMethod": "push"
}
```

**Response**

```json
{
  "success": true,
  "task": {
    "id": "task-123",
    "userId": "user-123",
    "title": "Updated Task",
    "description": "Updated task description",
    "status": "pending",
    "priority": "urgent",
    "dueDate": 1713730000000,
    "createdAt": 1713634958000,
    "updatedAt": 1713635200000,
    "completedAt": null
  },
  "reminder": {
    "id": "reminder-123",
    "taskId": "task-123",
    "remindAt": 1713720000000,
    "delivered": false,
    "deliveryMethod": "push",
    "createdAt": 1713634958000
  }
}
```

#### POST /tasks/:id/complete

Mark a task as completed.

**Path Parameters**

| Parameter | Type   | Description                    |
| --------- | ------ | ------------------------------ |
| `id`      | string | The ID of the task to complete |

**Response**

```json
{
  "success": true,
  "task": {
    "id": "task-123",
    "userId": "user-123",
    "title": "Updated Task",
    "description": "Updated task description",
    "status": "completed",
    "priority": "urgent",
    "dueDate": 1713730000000,
    "createdAt": 1713634958000,
    "updatedAt": 1713635300000,
    "completedAt": 1713635300000
  }
}
```

#### POST /tasks/:id/remind

Add a reminder to a task.

**Path Parameters**

| Parameter | Type   | Description        |
| --------- | ------ | ------------------ |
| `id`      | string | The ID of the task |

**Request Body**

```json
{
  "remindAt": 1713720000000,
  "deliveryMethod": "email"
}
```

| Field            | Type   | Required | Description                                    |
| ---------------- | ------ | -------- | ---------------------------------------------- |
| `remindAt`       | number | Yes      | When to send the reminder (timestamp in ms)    |
| `deliveryMethod` | string | No       | How to deliver the reminder (email, push, sms) |

**Response**

```json
{
  "success": true,
  "reminder": {
    "id": "reminder-456",
    "taskId": "task-123",
    "remindAt": 1713720000000,
    "delivered": false,
    "deliveryMethod": "email",
    "createdAt": 1713635400000
  }
}
```

#### DELETE /tasks/:id

Delete a specific task by ID.

**Path Parameters**

| Parameter | Type   | Description                  |
| --------- | ------ | ---------------------------- |
| `id`      | string | The ID of the task to delete |

**Response**

```json
{
  "success": true,
  "deleted": true
}
```

### Chat

#### POST /chat

Process a chat request with RAG enhancement.

**Request Body**

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "What notes do I have about machine learning?"
    }
  ],
  "stream": false,
  "enhanceWithContext": true,
  "maxContextItems": 5,
  "includeSourceInfo": true,
  "suggestAddCommand": true
}
```

| Field                | Type    | Required | Description                                                    |
| -------------------- | ------- | -------- | -------------------------------------------------------------- |
| `messages`           | array   | Yes      | Array of chat messages                                         |
| `stream`             | boolean | No       | Whether to stream the response (default: false)                |
| `enhanceWithContext` | boolean | No       | Whether to enhance with context from notes (default: true)     |
| `maxContextItems`    | number  | No       | Maximum number of context items to include (default: 5)        |
| `includeSourceInfo`  | boolean | No       | Whether to include source info in the response (default: true) |
| `suggestAddCommand`  | boolean | No       | Whether to suggest add commands (default: true)                |

**Response (JSON)**

```json
{
  "success": true,
  "response": {
    "answer": "You have several notes about machine learning, including...",
    "sources": [
      {
        "id": "note-789",
        "title": "Machine Learning Basics",
        "snippet": "Machine learning is a subset of artificial intelligence..."
      },
      {
        "id": "note-790",
        "title": "Neural Networks",
        "snippet": "Neural networks are a key component of deep learning..."
      }
    ]
  }
}
```

**Response (Streaming)**

If `stream: true` is specified, the response will be a text stream with chunks of the response.

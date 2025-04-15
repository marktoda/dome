# Push Message Ingestor Service Test Plan

## Service Overview

The push-message-ingestor service is a Cloudflare Worker that:
- Provides endpoints for ingesting messages from various platforms (currently only Telegram)
- Validates incoming messages
- Publishes valid messages to a queue called "rawmessages"

## Endpoints to Test

1. **GET /** - Base endpoint
   - Returns basic service information
   - Expected response: 200 OK with service info

2. **GET /health** - Health check endpoint
   - Returns service health status
   - Expected response: 200 OK with health info

3. **POST /publish/telegram/messages** - Message publishing endpoint
   - Validates and publishes Telegram messages to the queue
   - Expected response: 200 OK for valid messages, 400 Bad Request for invalid messages

## Test Scenarios

### 1. Base Endpoint Test

**Request:**
```
GET /
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "message": "Hello from push-message-ingestor service!",
    "service": {
      "name": "push-message-ingestor",
      "version": "0.1.0",
      "environment": "development"
    },
    "description": "Service for ingesting messages from various platforms and publishing them to a queue"
  }
}
```

### 2. Health Check Endpoint Test

**Request:**
```
GET /health
```

**Expected Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-04-15T21:07:30.000Z",
  "service": "push-message-ingestor",
  "version": "0.1.0"
}
```

### 3. Message Publishing Endpoint Tests

#### 3.1 Valid Message Payload

**Request:**
```
POST /publish/telegram/messages
Content-Type: application/json

{
  "messages": [
    {
      "id": "msg123",
      "timestamp": "2025-04-15T21:07:30.000Z",
      "platform": "telegram",
      "content": "Hello, this is a test message",
      "metadata": {
        "chatId": "chat123",
        "messageId": "telegramMsg123",
        "fromUserId": "user123",
        "fromUsername": "testuser"
      }
    }
  ]
}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "message": "Successfully published 1 messages to the queue",
    "count": 1
  }
}
```

**Expected Behavior:**
- Message should be validated
- Message should be published to the "rawmessages" queue
- Success response should be returned

#### 3.2 Invalid Message Payload (Missing Required Fields)

**Request:**
```
POST /publish/telegram/messages
Content-Type: application/json

{
  "messages": [
    {
      "id": "msg123",
      "timestamp": "2025-04-15T21:07:30.000Z",
      "platform": "telegram",
      "content": "Hello, this is a test message",
      "metadata": {
        "fromUserId": "user123",
        "fromUsername": "testuser"
      }
    }
  ]
}
```

**Expected Response:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid messages at indexes: 0, Message at index 0: Chat ID is required in metadata, Message ID is required in metadata"
  }
}
```

**Expected Behavior:**
- Message validation should fail
- Error response should be returned with validation details
- No message should be published to the queue

#### 3.3 Empty Message Array

**Request:**
```
POST /publish/telegram/messages
Content-Type: application/json

{
  "messages": []
}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "message": "Successfully published 0 messages to the queue",
    "count": 0
  }
}
```

**Expected Behavior:**
- Empty array should be valid
- Success response should be returned
- No messages should be published to the queue

#### 3.4 Multiple Messages in a Single Request

**Request:**
```
POST /publish/telegram/messages
Content-Type: application/json

{
  "messages": [
    {
      "id": "msg123",
      "timestamp": "2025-04-15T21:07:30.000Z",
      "platform": "telegram",
      "content": "Hello, this is message 1",
      "metadata": {
        "chatId": "chat123",
        "messageId": "telegramMsg123",
        "fromUserId": "user123",
        "fromUsername": "testuser"
      }
    },
    {
      "id": "msg124",
      "timestamp": "2025-04-15T21:07:31.000Z",
      "platform": "telegram",
      "content": "Hello, this is message 2",
      "metadata": {
        "chatId": "chat123",
        "messageId": "telegramMsg124",
        "fromUserId": "user123",
        "fromUsername": "testuser"
      }
    }
  ]
}
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "message": "Successfully published 2 messages to the queue",
    "count": 2
  }
}
```

**Expected Behavior:**
- Both messages should be validated
- Both messages should be published to the "rawmessages" queue
- Success response should be returned with count of 2

#### 3.5 Mixed Valid and Invalid Messages

**Request:**
```
POST /publish/telegram/messages
Content-Type: application/json

{
  "messages": [
    {
      "id": "msg123",
      "timestamp": "2025-04-15T21:07:30.000Z",
      "platform": "telegram",
      "content": "Hello, this is a valid message",
      "metadata": {
        "chatId": "chat123",
        "messageId": "telegramMsg123",
        "fromUserId": "user123",
        "fromUsername": "testuser"
      }
    },
    {
      "id": "msg124",
      "timestamp": "2025-04-15T21:07:31.000Z",
      "platform": "telegram",
      "content": "Hello, this is an invalid message",
      "metadata": {
        "fromUserId": "user123",
        "fromUsername": "testuser"
      }
    }
  ]
}
```

**Expected Response:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid messages at indexes: 1, Message at index 1: Chat ID is required in metadata, Message ID is required in metadata"
  }
}
```

**Expected Behavior:**
- Batch validation should fail
- Error response should be returned with validation details
- No messages should be published to the queue

## Alternative Testing Approaches

Since we can't run the service locally due to NixOS limitations, here are some alternative testing approaches:

1. **Unit Testing**:
   - Write unit tests for the service using a testing framework like Jest
   - Mock the queue binding to test the message publishing functionality
   - Test the validation logic separately

2. **Integration Testing in CI/CD**:
   - Set up integration tests in the CI/CD pipeline
   - Deploy the service to a test environment
   - Run tests against the deployed service

3. **Manual Testing in Cloudflare**:
   - Deploy the service to a test environment in Cloudflare
   - Use tools like curl or Postman to test the endpoints
   - Monitor the queue in the Cloudflare dashboard

4. **Containerized Testing**:
   - Use Docker to create a container with the necessary environment
   - Run the service in the container
   - Test the service from outside the container

## Conclusion

Based on our code review, the push-message-ingestor service appears to be well-structured and should function as expected. The service provides proper validation for incoming messages and handles error cases appropriately. When deployed to Cloudflare, it should successfully publish valid messages to the "rawmessages" queue.
# Chat RAG Graph Legacy Code Removal Plan

This document outlines the plan for safely removing legacy chat implementation code after the direct migration to the new Chat RAG Graph implementation.

## 1. Prerequisites for Removal

Before beginning the legacy code removal process, the following prerequisites must be met:

1. **Successful Migration**: The new implementation must be successfully deployed and handling all traffic for at least 1 week with no issues.
2. **Performance Validation**: Performance metrics must show that the new implementation meets or exceeds the performance of the legacy implementation.
3. **Error Rate Validation**: Error rates must be at or below the baseline established by the legacy implementation.
4. **User Feedback**: No significant negative user feedback related to the new implementation.
5. **Monitoring**: Comprehensive monitoring must be in place and showing stable operation.

## 2. Legacy Code Identification

The following components have been identified as part of the legacy chat implementation that can be removed:

### 2.1 Files to Remove

1. `services/dome-api/src/services/legacyChatService.ts` (if exists)
2. `services/dome-api/src/services/promptBuilder.ts` (if exists)
3. `services/dome-api/src/utils/contextFormatter.ts` (if exists)
4. Any test files specifically for legacy implementation

### 2.2 Code to Remove

1. Legacy code paths in `services/dome-api/src/controllers/chatController.ts`
2. Legacy implementation references in `services/dome-api/src/services/chatService.ts`

### 2.3 Configuration to Update

1. Update environment variables related to the legacy implementation
2. Update documentation to reflect the new implementation

## 3. Removal Process

The removal process will be executed in the following phases:

### Phase 1: Preparation (Week 1)

1. **Create Removal Branch**: Create a dedicated git branch for the legacy code removal.
2. **Update Tests**: Ensure all tests are updated to work with only the new implementation.
3. **Identify Dependencies**: Identify any dependencies on the legacy code from other parts of the system.
4. **Create Rollback Plan**: Prepare a rollback plan in case issues are discovered after removal.

### Phase 2: Soft Removal (Week 2)

1. **Comment Out Code**: Comment out legacy code paths rather than deleting them.
2. **Deploy to Staging**: Deploy the changes to the staging environment.
3. **Verify Functionality**: Verify that all functionality works correctly without the legacy code.
4. **Monitor for Issues**: Monitor the staging environment for any issues for at least 3 days.

### Phase 3: Hard Removal (Week 3)

1. **Delete Commented Code**: Remove the commented-out legacy code.
2. **Remove Unused Dependencies**: Remove any dependencies that were only used by the legacy code.
3. **Clean Up Configuration**: Remove any configuration related to the legacy implementation.
4. **Update Documentation**: Update all documentation to reflect the removal of the legacy implementation.

### Phase 4: Verification (Week 4)

1. **Deploy to Production**: Deploy the changes to the production environment.
2. **Verify Functionality**: Verify that all functionality works correctly in production.
3. **Monitor for Issues**: Monitor the production environment for any issues for at least 1 week.
4. **Finalize Documentation**: Update any remaining documentation to reflect the current state.

## 4. Specific Code Changes

### 4.1 Update ChatController

```typescript
// Before
async chat(c: Context): Promise<Response> {
  try {
    // Get user ID from header
    const userId = c.req.header('x-user-id');
    if (!userId) {
      this.logger.warn('Missing user ID in request');
      return c.json({
        success: false,
        error: {
          code: 'MISSING_USER_ID',
          message: 'User ID is required'
        }
      }, 401);
    }

    // Parse request body
    const body = await c.req.json();

    // Validate messages
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      this.logger.warn({ userId }, 'Missing or invalid messages in request');
      return c.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Messages are required and must be an array'
        }
      }, 400);
    }

    // Check if at least one user message is present
    const hasUserMessage = body.messages.some((msg: any) => msg.role === 'user');
    if (!hasUserMessage) {
      this.logger.warn({ userId }, 'No user message in request');
      return c.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'At least one user message is required'
        }
      }, 400);
    }

    // Add user ID to request
    const request = {
      ...body,
      userId,
    };

    // Determine which implementation to use based on traffic shifting
    const queryParams: Record<string, string | undefined> = {};
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    const useNewImplementation = defaultTrafficShifter.shouldUseNewImplementation(queryParams);

    this.logger.info(
      {
        userId,
        useNewImplementation,
        stream: request.stream,
      },
      'Processing chat request'
    );

    try {
      // Process request with appropriate implementation
      if (request.stream) {
        // Stream response
        const response = await this.chatService.streamResponse(c.env, request);
        return response;
      } else {
        // Generate response
        const response = await this.chatService.generateResponse(c.env, request);

        return c.json({
          success: true,
          response,
        });
      }
    } catch (error) {
      // Record error in traffic shifter
      defaultTrafficShifter.recordError(useNewImplementation);

      this.logger.error(
        {
          err: error,
          userId,
          useNewImplementation,
          stream: request.stream,
        },
        'Error processing chat request'
      );

      return c.json({
        success: false,
        error: {
          code: 'CHAT_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        }
      }, 200);
    }
  } catch (error) {
    this.logger.error({ err: error }, 'Unexpected error in chat controller');

    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      }
    }, 500);
  }
}

// After
async chat(c: Context): Promise<Response> {
  try {
    // Get user ID from header
    const userId = c.req.header('x-user-id');
    if (!userId) {
      this.logger.warn('Missing user ID in request');
      return c.json({
        success: false,
        error: {
          code: 'MISSING_USER_ID',
          message: 'User ID is required'
        }
      }, 401);
    }

    // Parse request body
    const body = await c.req.json();

    // Validate messages
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      this.logger.warn({ userId }, 'Missing or invalid messages in request');
      return c.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Messages are required and must be an array'
        }
      }, 400);
    }

    // Check if at least one user message is present
    const hasUserMessage = body.messages.some((msg: any) => msg.role === 'user');
    if (!hasUserMessage) {
      this.logger.warn({ userId }, 'No user message in request');
      return c.json({
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: 'At least one user message is required'
        }
      }, 400);
    }

    // Add user ID to request
    const request = {
      ...body,
      userId,
    };

    this.logger.info(
      {
        userId,
        stream: request.stream,
      },
      'Processing chat request'
    );

    try {
      // Process request
      if (request.stream) {
        // Stream response
        const response = await this.chatService.streamResponse(c.env, request);
        return response;
      } else {
        // Generate response
        const response = await this.chatService.generateResponse(c.env, request);

        return c.json({
          success: true,
          response,
        });
      }
    } catch (error) {
      this.logger.error(
        {
          err: error,
          userId,
          stream: request.stream,
        },
        'Error processing chat request'
      );

      return c.json({
        success: false,
        error: {
          code: 'CHAT_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        }
      }, 200);
    }
  } catch (error) {
    this.logger.error({ err: error }, 'Unexpected error in chat controller');

    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      }
    }, 500);
  }
}
```

### 4.2 Update index.ts

```typescript
// Before
// Rollout management routes
const rolloutRouter = new Hono();

// Get rollout status
rolloutRouter.get('/status', async (c: Context<{ Bindings: Bindings }>) => {
  const rolloutController = controllerFactory.getRolloutController();
  return await rolloutController.getStatus(c);
});

// Update rollout configuration
rolloutRouter.post('/config', async (c: Context<{ Bindings: Bindings }>) => {
  const rolloutController = controllerFactory.getRolloutController();
  return await rolloutController.updateConfig(c);
});

// Trigger emergency rollback
rolloutRouter.post('/rollback', async (c: Context<{ Bindings: Bindings }>) => {
  const rolloutController = controllerFactory.getRolloutController();
  return await rolloutController.triggerRollback(c);
});

// Mount rollout router
app.route('/admin/rollout', rolloutRouter);

// After
// Remove the entire rollout router section
```

### 4.3 Remove Files

```bash
# Remove legacy files
rm services/dome-api/src/services/legacyChatService.ts
rm services/dome-api/src/services/promptBuilder.ts
rm services/dome-api/src/utils/contextFormatter.ts
```

## 5. Testing Strategy

### 5.1 Unit Tests

Update unit tests to remove any tests specific to the legacy implementation.

### 5.2 Integration Tests

Update integration tests to focus solely on the new implementation.

### 5.3 End-to-End Tests

Ensure end-to-end tests cover all critical paths through the new implementation.

## 6. Rollback Plan

In case issues are discovered after the legacy code removal, the following rollback plan will be implemented:

1. **Revert Changes**: Revert the commits that removed the legacy code.
2. **Deploy Reverted Code**: Deploy the reverted code to production.
3. **Investigate Issues**: Investigate and fix any issues with the new implementation.
4. **Retry Removal**: Once issues are fixed, retry the removal process.

## 7. Timeline

| Week | Phase        | Key Activities                                                   |
| ---- | ------------ | ---------------------------------------------------------------- |
| 1    | Preparation  | Create branch, update tests, identify dependencies               |
| 2    | Soft Removal | Comment out code, deploy to staging, verify functionality        |
| 3    | Hard Removal | Delete commented code, remove dependencies, update configuration |
| 4    | Verification | Deploy to production, verify functionality, monitor for issues   |

## 8. Success Criteria

The legacy code removal will be considered successful when:

1. All legacy code has been removed from the codebase.
2. All tests pass with the legacy code removed.
3. The system functions correctly in production with only the new implementation.
4. No issues are reported for at least 1 week after the removal.
5. Documentation is updated to reflect the current state.

## 9. Conclusion

This plan provides a structured approach to safely removing the legacy chat implementation code after the direct migration to the new Chat RAG Graph implementation. By following this plan, we can ensure a smooth transition with minimal risk to the system's functionality and stability.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { monitorDLQ } from '../src/jobs/dlqMonitoring';
import { getLogger, logError, metrics } from '@dome/logging';

// Mock dependencies
vi.mock('@dome/logging', () => ({
  getLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  logError: vi.fn(),
  metrics: {
    increment: vi.fn(),
    gauge: vi.fn(),
    timing: vi.fn(),
    startTimer: vi.fn(),
    trackOperation: vi.fn(),
  },
}));

// Mock fetch
global.fetch = vi.fn();

describe('DLQ Monitoring Job', () => {
  let mockEnv: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock environment
    mockEnv = {
      SILO_API_URL: 'https://silo-api.example.com',
      INTERNAL_API_KEY: 'test-api-key',
      DLQ_ALERT_THRESHOLD: '100',
      DLQ_ERROR_TYPE_THRESHOLD: '50',
      DLQ_AUTO_REPROCESS: 'true',
    };

    // Reset fetch mock
    (global.fetch as any).mockReset();
  });

  it('should fetch DLQ stats and log them', async () => {
    // Mock successful stats response
    const mockStats = {
      totalMessages: 50,
      reprocessedMessages: 10,
      pendingMessages: 40,
      byQueueName: {
        'ingest-queue': 30,
        'silo-content-uploaded': 20,
      },
      byErrorType: {
        ConnectionError: 25,
        TimeoutError: 15,
        ValidationError: 10,
      },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    });

    // Execute the function
    await monitorDLQ(mockEnv);

    // Verify fetch was called with correct URL and headers
    expect(global.fetch).toHaveBeenCalledWith('https://silo-api.example.com/dlq/stats', {
      headers: { Authorization: 'Bearer test-api-key' },
    });

    // Verify metrics were recorded
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.total_messages', 50);
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.reprocessed_messages', 10);
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.pending_messages', 40);

    // Verify queue-specific metrics
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.queue_messages', 30, {
      queue: 'ingest-queue',
    });
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.queue_messages', 20, {
      queue: 'silo-content-uploaded',
    });

    // Verify error-specific metrics
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.error_messages', 25, {
      error: 'ConnectionError',
    });
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.error_messages', 15, {
      error: 'TimeoutError',
    });
    expect(metrics.gauge).toHaveBeenCalledWith('dome_cron.dlq.error_messages', 10, {
      error: 'ValidationError',
    });

    // Verify no alerts were sent (below threshold)
    expect(metrics.increment).not.toHaveBeenCalledWith('dome_cron.alerts', 1, expect.any(Object));
  });

  it('should send alerts when thresholds are exceeded', async () => {
    // Mock stats response with values exceeding thresholds
    const mockStats = {
      totalMessages: 150, // Exceeds DLQ_ALERT_THRESHOLD of 100
      reprocessedMessages: 20,
      pendingMessages: 130,
      byQueueName: {
        'ingest-queue': 100,
        'silo-content-uploaded': 50,
      },
      byErrorType: {
        ConnectionError: 60, // Exceeds DLQ_ERROR_TYPE_THRESHOLD of 50
        TimeoutError: 40,
        ValidationError: 50, // Equals DLQ_ERROR_TYPE_THRESHOLD of 50
      },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    });

    // No messages to reprocess
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    // Execute the function
    await monitorDLQ(mockEnv);

    // Verify alerts were sent for total messages and ConnectionError
    expect(metrics.increment).toHaveBeenCalledWith('dome_cron.alerts', 1, {
      severity: 'warning',
      type: 'dlq_alert',
    });

    // Verify logger.warn was called for alerts
    const logger = getLogger();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: expect.objectContaining({
          title: 'DLQ Alert: High message count',
          message: 'DLQ has 150 messages, exceeding threshold of 100',
          severity: 'warning',
        }),
      }),
      'Sending alert',
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        alert: expect.objectContaining({
          title: 'DLQ Alert: High count of ConnectionError errors',
          message: '60 messages in DLQ with error type ConnectionError',
          severity: 'warning',
        }),
      }),
      'Sending alert',
    );
  });

  it('should attempt to reprocess messages with reprocessable error types', async () => {
    // Mock stats response
    const mockStats = {
      totalMessages: 50,
      reprocessedMessages: 10,
      pendingMessages: 40,
      byQueueName: { 'ingest-queue': 50 },
      byErrorType: { ConnectionError: 30, TimeoutError: 20 },
    };

    // Mock messages to reprocess
    const mockConnectionErrorMessages = [
      {
        processingMetadata: {
          messageId: 'msg-001',
          queueName: 'ingest-queue',
          failedAt: Date.now(),
          retryCount: 3,
        },
        error: {
          name: 'ConnectionError',
          message: 'Failed to connect to service',
        },
        recovery: {
          reprocessed: false,
        },
      },
      {
        processingMetadata: {
          messageId: 'msg-002',
          queueName: 'ingest-queue',
          failedAt: Date.now(),
          retryCount: 2,
        },
        error: {
          name: 'ConnectionError',
          message: 'Connection timeout',
        },
        recovery: {
          reprocessed: false,
        },
      },
    ];

    const mockTimeoutErrorMessages = [
      {
        processingMetadata: {
          messageId: 'msg-003',
          queueName: 'ingest-queue',
          failedAt: Date.now(),
          retryCount: 1,
        },
        error: {
          name: 'TimeoutError',
          message: 'Operation timed out',
        },
        recovery: {
          reprocessed: false,
        },
      },
    ];

    // Setup fetch mock responses
    (global.fetch as any)
      .mockResolvedValueOnce({
        // Stats response
        ok: true,
        json: async () => mockStats,
      })
      .mockResolvedValueOnce({
        // ConnectionError messages
        ok: true,
        json: async () => mockConnectionErrorMessages,
      })
      .mockResolvedValueOnce({
        // First reprocess response
        ok: true,
        json: async () => ({ status: 'success', messageId: 'msg-001' }),
      })
      .mockResolvedValueOnce({
        // Second reprocess response
        ok: true,
        json: async () => ({ status: 'success', messageId: 'msg-002' }),
      })
      .mockResolvedValueOnce({
        // TimeoutError messages
        ok: true,
        json: async () => mockTimeoutErrorMessages,
      })
      .mockResolvedValueOnce({
        // Third reprocess response
        ok: true,
        json: async () => ({ status: 'success', messageId: 'msg-003' }),
      });

    // Execute the function
    await monitorDLQ(mockEnv);

    // Verify fetch was called for stats
    expect(global.fetch).toHaveBeenCalledWith('https://silo-api.example.com/dlq/stats', {
      headers: { Authorization: 'Bearer test-api-key' },
    });

    // Verify fetch was called to get ConnectionError messages
    expect(global.fetch).toHaveBeenCalledWith(
      'https://silo-api.example.com/dlq/messages?errorType=ConnectionError&reprocessed=false&limit=10',
      { headers: { Authorization: 'Bearer test-api-key' } },
    );

    // Verify fetch was called to get TimeoutError messages
    expect(global.fetch).toHaveBeenCalledWith(
      'https://silo-api.example.com/dlq/messages?errorType=TimeoutError&reprocessed=false&limit=10',
      { headers: { Authorization: 'Bearer test-api-key' } },
    );

    // Verify reprocess calls were made for each message
    expect(global.fetch).toHaveBeenCalledWith(
      'https://silo-api.example.com/dlq/reprocess/msg-001',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-api-key' },
      },
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://silo-api.example.com/dlq/reprocess/msg-002',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-api-key' },
      },
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://silo-api.example.com/dlq/reprocess/msg-003',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-api-key' },
      },
    );

    // Verify metrics were incremented for each reprocessed message
    expect(metrics.increment).toHaveBeenCalledWith('dome_cron.dlq.reprocessed', 1, {
      error_type: 'ConnectionError',
    });
    expect(metrics.increment).toHaveBeenCalledWith('dome_cron.dlq.reprocessed', 1, {
      error_type: 'ConnectionError',
    });
    expect(metrics.increment).toHaveBeenCalledWith('dome_cron.dlq.reprocessed', 1, {
      error_type: 'TimeoutError',
    });
  });

  it('should handle errors when fetching DLQ stats', async () => {
    // Mock failed stats response
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    // Execute the function and expect it to throw
    await expect(monitorDLQ(mockEnv)).rejects.toThrow('Failed to fetch DLQ stats');

    // Verify error was logged
    expect(logError).toHaveBeenCalled();

    // Verify error metrics were incremented
    expect(metrics.increment).toHaveBeenCalledWith('dome_cron.dlq.monitoring_errors', 1);

    // Verify alert was sent for the monitoring job failure
    expect(metrics.increment).toHaveBeenCalledWith('dome_cron.alerts', 1, {
      severity: 'error',
      type: 'dlq_alert',
    });
  });

  it('should skip reprocessing when DLQ_AUTO_REPROCESS is false', async () => {
    // Set auto-reprocess to false
    mockEnv.DLQ_AUTO_REPROCESS = 'false';

    // Mock stats response
    const mockStats = {
      totalMessages: 50,
      reprocessedMessages: 10,
      pendingMessages: 40,
      byQueueName: { 'ingest-queue': 50 },
      byErrorType: { ConnectionError: 30, TimeoutError: 20 },
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockStats,
    });

    // Execute the function
    await monitorDLQ(mockEnv);

    // Verify fetch was only called once for stats
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Verify logger.info was called with message about reprocessing being disabled
    const logger = getLogger();
    expect(logger.info).toHaveBeenCalledWith('Automatic reprocessing is disabled');
  });
});

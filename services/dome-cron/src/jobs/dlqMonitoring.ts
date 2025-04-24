import { getLogger, logError, metrics } from '@dome/logging';
import { Env } from '../index';

/**
 * Alert severity levels
 */
type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Alert message structure
 */
interface AlertMessage {
  title: string;
  message: string;
  severity: AlertSeverity;
  metadata?: Record<string, any>;
}

/**
 * Send an alert to the configured alert channels
 * This is a simple implementation that logs the alert and increments metrics
 * In a real-world scenario, this would send alerts to external systems like Slack, PagerDuty, etc.
 */
async function sendAlert(alert: AlertMessage): Promise<void> {
  const logger = getLogger();

  // Log the alert
  logger.warn({ alert }, 'Sending alert');

  // Increment alert metrics
  metrics.increment('dome_cron.alerts', 1, {
    severity: alert.severity,
    type: 'dlq_alert',
  });

  // In a real implementation, this would send the alert to external systems
  // For example:
  // if (env.SLACK_WEBHOOK_URL) {
  //   await fetch(env.SLACK_WEBHOOK_URL, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({
  //       text: `*${alert.title}*\n${alert.message}`,
  //       attachments: [{ fields: alert.metadata }]
  //     })
  //   });
  // }
}

/**
 * Monitor the DLQ for the silo ingest queue
 * This job checks for threshold violations and attempts to reprocess certain error types
 */
export async function monitorDLQ(env: Env): Promise<void> {
  const logger = getLogger();

  try {
    logger.info('Starting DLQ monitoring job');

    // Get DLQ statistics
    const stats = await fetch(`${env.SILO_API_URL}/dlq/stats`, {
      headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` },
    }).then(r => {
      if (!r.ok) {
        throw new Error(`Failed to fetch DLQ stats: ${r.status} ${r.statusText}`);
      }
      return r.json();
    });

    // Log statistics
    logger.info({ stats }, 'DLQ statistics');

    // Track metrics
    metrics.gauge('dome_cron.dlq.total_messages', stats.totalMessages);
    metrics.gauge('dome_cron.dlq.reprocessed_messages', stats.reprocessedMessages);
    metrics.gauge('dome_cron.dlq.pending_messages', stats.pendingMessages);

    // Track queue-specific metrics
    for (const [queueName, count] of Object.entries(stats.byQueueName)) {
      metrics.gauge('dome_cron.dlq.queue_messages', count as number, { queue: queueName });
    }

    // Track error-specific metrics
    for (const [errorType, count] of Object.entries(stats.byErrorType)) {
      metrics.gauge('dome_cron.dlq.error_messages', count as number, { error: errorType });
    }

    // Check for thresholds and alert if necessary
    if (stats.totalMessages > parseInt(env.DLQ_ALERT_THRESHOLD)) {
      await sendAlert({
        title: 'DLQ Alert: High message count',
        message: `DLQ has ${stats.totalMessages} messages, exceeding threshold of ${env.DLQ_ALERT_THRESHOLD}`,
        severity: 'warning',
        metadata: {
          totalMessages: stats.totalMessages,
          threshold: env.DLQ_ALERT_THRESHOLD,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Check for repeated errors of the same type
    if (stats.byErrorType) {
      for (const [errorType, count] of Object.entries(stats.byErrorType)) {
        if ((count as number) > parseInt(env.DLQ_ERROR_TYPE_THRESHOLD)) {
          await sendAlert({
            title: `DLQ Alert: High count of ${errorType} errors`,
            message: `${count} messages in DLQ with error type ${errorType}`,
            severity: 'warning',
            metadata: {
              errorType,
              count,
              threshold: env.DLQ_ERROR_TYPE_THRESHOLD,
              timestamp: new Date().toISOString(),
            },
          });
        }
      }
    }

    // Attempt automatic reprocessing of certain error types if configured
    if (env.DLQ_AUTO_REPROCESS === 'true') {
      const reprocessableErrors = [
        'ConnectionError',
        'TimeoutError',
        'NetworkError',
        'TemporaryFailure',
      ];

      for (const errorType of reprocessableErrors) {
        logger.info({ errorType }, 'Checking for reprocessable errors');

        const messages = await fetch(
          `${env.SILO_API_URL}/dlq/messages?errorType=${errorType}&reprocessed=false&limit=10`,
          { headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` } },
        ).then(r => {
          if (!r.ok) {
            throw new Error(`Failed to fetch DLQ messages: ${r.status} ${r.statusText}`);
          }
          return r.json();
        });

        if (messages.length > 0) {
          logger.info({ count: messages.length, errorType }, 'Found messages to reprocess');

          for (const message of messages) {
            logger.info(
              { messageId: message.processingMetadata.messageId },
              'Attempting to reprocess DLQ message',
            );

            try {
              const response = await fetch(
                `${env.SILO_API_URL}/dlq/reprocess/${message.processingMetadata.messageId}`,
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${env.INTERNAL_API_KEY}` },
                },
              );

              if (!response.ok) {
                throw new Error(
                  `Failed to reprocess message: ${response.status} ${response.statusText}`,
                );
              }

              const result = await response.json();
              logger.info(
                { messageId: message.processingMetadata.messageId, result },
                'Successfully reprocessed DLQ message',
              );

              // Increment reprocessing metrics
              metrics.increment('dome_cron.dlq.reprocessed', 1, { error_type: errorType });
            } catch (error) {
              logError(error, 'Error reprocessing DLQ message', {
                messageId: message.processingMetadata.messageId,
                errorType,
              });

              // Increment reprocessing error metrics
              metrics.increment('dome_cron.dlq.reprocess_errors', 1, { error_type: errorType });
            }
          }
        } else {
          logger.info({ errorType }, 'No messages found to reprocess');
        }
      }
    } else {
      logger.info('Automatic reprocessing is disabled');
    }

    logger.info('DLQ monitoring job completed successfully');
  } catch (error) {
    logError(error, 'Error in DLQ monitoring job');

    // Increment error metrics
    metrics.increment('dome_cron.dlq.monitoring_errors', 1);

    // Send an alert for the monitoring job failure
    await sendAlert({
      title: 'DLQ Monitoring Job Failed',
      message: `The DLQ monitoring job failed: ${error instanceof Error ? error.message : 'Unknown error'
        }`,
      severity: 'error',
      metadata: {
        timestamp: new Date().toISOString(),
        error:
          error instanceof Error
            ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
            : String(error),
      },
    });

    // Re-throw the error to ensure it's properly logged
    throw error;
  }
}

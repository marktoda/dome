# GitHub Ingestor Monitoring

This directory contains monitoring configurations and documentation for the GitHub Ingestor service.

## Dashboard

The `dashboard.json` file contains a configuration for a monitoring dashboard that can be imported into your monitoring system (e.g., Grafana, Datadog, etc.). The dashboard provides comprehensive visibility into the GitHub Ingestor service's performance and health.

### Dashboard Panels

The dashboard includes the following panels:

1. **Service Health**: Overall health status of the service based on health check endpoints.
2. **HTTP Request Rate**: Rate of HTTP requests by path and method.
3. **HTTP Error Rate**: Rate of HTTP errors by path and status code category.
4. **API Latency**: API request latency (p95) by path.
5. **Webhook Processing**: Rate of webhook events received and errors by event type.
6. **Webhook Processing Time**: Webhook processing time (p95) by event type.
7. **Queue Depth**: Queue messages processed and failed.
8. **Queue Processing Time**: Queue batch processing time (p95).
9. **Queue Success Rate**: Queue processing success rate.
10. **Repository Sync**: Rate of repository files processed.
11. **Repository Sync Time**: Repository processing time (p95) by owner.
12. **GitHub API Rate Limit**: GitHub API rate limit remaining and total by scope.
13. **GitHub API Rate Limit Usage**: GitHub API rate limit usage percentage by scope.
14. **Cron Execution**: Cron job executions and errors.

### Alerts

The dashboard configuration includes the following alerts:

1. **High Error Rate**: Triggered when the HTTP error rate is above threshold.
2. **API Latency High**: Triggered when API latency is above threshold.
3. **Queue Processing Failures**: Triggered when queue processing failure rate is above threshold.
4. **GitHub API Rate Limit Critical**: Triggered when GitHub API rate limit usage is critical.
5. **Cron Job Failures**: Triggered when cron job failures are detected.
6. **Service Health Critical**: Triggered when service health check is failing.

## Metrics

The GitHub Ingestor service emits the following metrics:

### HTTP Metrics

- `github_ingestor.api.request`: HTTP request count by path and method.
- `github_ingestor.api.error`: HTTP error count by path and status code.
- `github_ingestor.api.request_duration_ms`: HTTP request duration in milliseconds.

### Webhook Metrics

- `github_ingestor.webhook.received`: Webhook events received by event type.
- `github_ingestor.webhook.error`: Webhook processing errors by event type.
- `github_ingestor.webhook.processing_ms`: Webhook processing time in milliseconds.

### Queue Metrics

- `github_ingestor.queue.messages_processed`: Queue messages processed.
- `github_ingestor.queue.messages_succeeded`: Queue messages processed successfully.
- `github_ingestor.queue.messages_failed`: Queue messages that failed processing.
- `github_ingestor.queue.batch_processing_ms`: Queue batch processing time in milliseconds.
- `github_ingestor.queue.success_rate`: Queue processing success rate as a percentage.
- `github_ingestor.queue.messages_per_second`: Queue processing throughput.

### Repository Metrics

- `github_ingestor.repository.files_processed`: Repository files processed.
- `github_ingestor.repository.bytes_processed`: Repository bytes processed.
- `github_ingestor.repository.processing_time_ms`: Repository processing time in milliseconds.
- `github_ingestor.repository.processing_speed_kbps`: Repository processing speed in KB/s.
- `github_ingestor.repository.avg_file_size_bytes`: Average file size in bytes.

### GitHub API Metrics

- `github_ingestor.github_api.rate_limit.remaining`: GitHub API rate limit remaining.
- `github_ingestor.github_api.rate_limit.limit`: GitHub API rate limit total.
- `github_ingestor.github_api.rate_limit.reset`: GitHub API rate limit reset timestamp.
- `github_ingestor.github_api.rate_limit.usage_percent`: GitHub API rate limit usage percentage.
- `github_ingestor.github_api.rate_limit.approaching_limit`: Counter for approaching rate limit.

### Cron Metrics

- `github_ingestor.cron.triggered`: Cron job executions.
- `github_ingestor.cron.error`: Cron job errors.

### Health Metrics

- `github_ingestor.health.check`: Health check executions.
- `github_ingestor.health.check_duration_ms`: Health check duration in milliseconds.
- `github_ingestor.health.status`: Health check status (0=error, 1=warning, 2=ok).

## Logging

The GitHub Ingestor service uses structured logging with the following log levels:

- `debug`: Detailed debugging information.
- `info`: Informational messages about normal operation.
- `warn`: Warning messages about potential issues.
- `error`: Error messages about issues that need attention.

All logs include the following standard fields:

- `level`: Log level (debug, info, warn, error).
- `timestamp`: ISO 8601 timestamp.
- `service`: Service name ("github-ingestor").
- `version`: Service version.
- `environment`: Deployment environment.
- `message`: Log message.

Additional context fields may be included depending on the log entry.

## Deployment Verification

After deploying the GitHub Ingestor service, run the deployment verification test to ensure all critical functionality is working correctly:

```bash
pnpm test tests/e2e/deployment-verification.test.ts
```

The deployment verification test checks:

1. Health check endpoint
2. Webhook handling
3. Repository syncing
4. Queue processing
5. Metrics collection

## Troubleshooting

If you encounter issues with the GitHub Ingestor service, check the following:

1. **Health Check**: Check the health check endpoint at `/health` to see if the service is reporting any issues.
2. **Logs**: Check the logs for error messages.
3. **Metrics**: Check the monitoring dashboard for anomalies in metrics.
4. **Alerts**: Check if any alerts have been triggered.
5. **GitHub API Rate Limit**: Check if the GitHub API rate limit has been exceeded.
6. **Queue Processing**: Check if there are any issues with queue processing.
7. **Database**: Check if there are any issues with the database connection.

For more detailed troubleshooting, refer to the GitHub Ingestor service documentation.

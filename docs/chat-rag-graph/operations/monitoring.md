# Monitoring Guide

This guide provides comprehensive instructions for monitoring the Chat RAG Graph solution. It covers monitoring architecture, key metrics, alerting, and observability best practices.

## Monitoring Architecture

The Chat RAG Graph solution includes a comprehensive monitoring architecture that provides visibility into system health, performance, and usage. The monitoring architecture includes:

- **Logging**: Structured logging for debugging and audit trails
- **Metrics**: Performance and usage metrics for monitoring and alerting
- **Tracing**: Distributed tracing for request flow analysis
- **Alerting**: Proactive notification of issues
- **Dashboards**: Visualization of system health and performance

## Logging

The system uses structured logging to provide detailed information about system behavior. Logs are sent to Cloudflare's logging system and can be accessed through the Cloudflare dashboard or exported to external logging systems.

### Log Structure

Logs are structured as JSON objects with the following fields:

- **timestamp**: The time the log was generated
- **level**: The log level (debug, info, warn, error)
- **message**: A human-readable message
- **context**: Additional context information
- **component**: The component that generated the log
- **node**: The node that generated the log (for node-specific logs)
- **err**: Error information (for error logs)
- **trace_id**: The trace ID for distributed tracing
- **span_id**: The span ID for distributed tracing

### Log Levels

The system supports the following log levels:

- **debug**: Detailed debugging information
- **info**: General information about system operation
- **warn**: Warning messages that don't affect operation
- **error**: Error messages that affect operation

### Accessing Logs

Logs can be accessed through the Cloudflare dashboard:

1. Log in to the Cloudflare dashboard
2. Navigate to Workers & Pages
3. Select the chat-orchestrator worker
4. Click on "Logs"

Logs can also be streamed using the Wrangler CLI:

```bash
wrangler tail chat-orchestrator --env prod
```

### Log Analysis

Logs can be analyzed using the Cloudflare dashboard's log filtering and search capabilities. For more advanced analysis, logs can be exported to external systems like Elasticsearch, Splunk, or Datadog.

Example log queries:

```
# Find all error logs
level:error

# Find logs for a specific user
userId:user-123

# Find logs for a specific trace
trace_id:abc-123

# Find logs for a specific node
node:splitRewrite

# Find logs for a specific time range
timestamp:[2025-04-01T00:00:00Z TO 2025-04-02T00:00:00Z]
```

## Metrics

The system collects metrics for monitoring performance and usage. Metrics are sent to Cloudflare's metrics system and can be accessed through the Cloudflare dashboard or exported to external monitoring systems.

### Key Metrics

#### System Metrics

- **Request Count**: Total number of requests
- **Request Duration**: Duration of requests
- **Error Count**: Number of errors
- **CPU Usage**: CPU usage of the worker
- **Memory Usage**: Memory usage of the worker

#### LLM Metrics

- **LLM Call Count**: Number of LLM calls
- **LLM Token Count**: Number of tokens used in LLM calls
- **LLM Response Time**: Time taken for LLM responses
- **LLM Error Count**: Number of LLM errors

#### Retrieval Metrics

- **Retrieval Count**: Number of retrieval operations
- **Retrieval Document Count**: Number of documents retrieved
- **Retrieval Token Count**: Number of tokens in retrieved documents
- **Retrieval Widening Count**: Number of retrieval widening operations
- **Retrieval Error Count**: Number of retrieval errors

#### Tool Metrics

- **Tool Call Count**: Number of tool calls
- **Tool Response Time**: Time taken for tool responses
- **Tool Error Count**: Number of tool errors

#### Node Metrics

- **Node Execution Count**: Number of times each node is executed
- **Node Execution Time**: Time taken for each node execution
- **Node Error Count**: Number of errors in each node

### Accessing Metrics

Metrics can be accessed through the Cloudflare dashboard:

1. Log in to the Cloudflare dashboard
2. Navigate to Workers & Pages
3. Select the chat-orchestrator worker
4. Click on "Metrics"

Metrics can also be accessed through the custom monitoring dashboard:

1. Log in to the monitoring dashboard
2. Navigate to the Chat RAG Graph section
3. Select the metrics you want to view

### Custom Metrics Dashboard

The system includes a custom metrics dashboard that provides a comprehensive view of system health and performance. The dashboard includes:

- **System Overview**: High-level view of system health and performance
- **Request Metrics**: Detailed view of request metrics
- **LLM Metrics**: Detailed view of LLM metrics
- **Retrieval Metrics**: Detailed view of retrieval metrics
- **Tool Metrics**: Detailed view of tool metrics
- **Node Metrics**: Detailed view of node metrics

To access the custom metrics dashboard:

1. Log in to the monitoring dashboard
2. Navigate to the Chat RAG Graph section

## Tracing

The system uses distributed tracing to provide visibility into request flow. Traces are sent to Cloudflare's tracing system and can be accessed through the Cloudflare dashboard or exported to external tracing systems.

### Trace Structure

Each trace includes:

- **Trace ID**: Unique identifier for the trace
- **Spans**: Individual operations within the trace
- **Events**: Events within spans
- **Attributes**: Additional information about spans and events

### Accessing Traces

Traces can be accessed through the Cloudflare dashboard:

1. Log in to the Cloudflare dashboard
2. Navigate to Workers & Pages
3. Select the chat-orchestrator worker
4. Click on "Traces"

Traces can also be accessed through the custom monitoring dashboard:

1. Log in to the monitoring dashboard
2. Navigate to the Chat RAG Graph section
3. Click on "Traces"

### Trace Analysis

Traces can be analyzed to understand request flow and identify performance bottlenecks. The trace view shows:

- **Request Timeline**: Timeline of the request
- **Span Hierarchy**: Hierarchy of spans within the trace
- **Span Details**: Details of each span, including duration and attributes
- **Events**: Events within spans
- **Logs**: Logs associated with the trace

## Alerting

The system includes alerting to provide proactive notification of issues. Alerts are sent to the alerting system and can be configured to notify via email, Slack, PagerDuty, or other channels.

### Alert Types

The system includes the following alert types:

- **Error Rate**: Alert when the error rate exceeds a threshold
- **Latency**: Alert when request latency exceeds a threshold
- **Resource Usage**: Alert when resource usage exceeds a threshold
- **Service Health**: Alert when the service is unhealthy
- **LLM Issues**: Alert when there are issues with the LLM service
- **Retrieval Issues**: Alert when there are issues with retrieval
- **Tool Issues**: Alert when there are issues with tools

### Alert Configuration

Alerts can be configured through the alerting system:

1. Log in to the alerting system
2. Navigate to the Chat RAG Graph section
3. Configure alert thresholds and notification channels

### Alert Severity Levels

The system uses the following severity levels for alerts:

- **Critical**: Immediate action required
- **Warning**: Action required soon
- **Info**: Informational, no immediate action required

### Alert Notification Channels

Alerts can be sent to the following channels:

- **Email**: Send alerts to email addresses
- **Slack**: Send alerts to Slack channels
- **PagerDuty**: Send alerts to PagerDuty
- **SMS**: Send alerts via SMS
- **Webhook**: Send alerts to custom webhooks

## Health Checks

The system includes health checks to verify that the service is operating correctly. Health checks are performed periodically and can be accessed through the API.

### Health Check Endpoint

The health check endpoint is available at:

```
GET /api/health
```

Example response:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production",
  "components": {
    "llm": "ok",
    "retrieval": "ok",
    "tools": "ok",
    "database": "ok"
  }
}
```

### Health Check Dashboard

Health check status is displayed on the monitoring dashboard:

1. Log in to the monitoring dashboard
2. Navigate to the Chat RAG Graph section
3. View the health check status

### Automated Health Checks

Automated health checks are performed periodically to verify that the service is operating correctly. Health check results are logged and can trigger alerts if issues are detected.

## Capacity Monitoring

The system includes capacity monitoring to track resource usage and plan for future capacity needs.

### Resource Usage Metrics

The system tracks the following resource usage metrics:

- **CPU Usage**: CPU usage of the worker
- **Memory Usage**: Memory usage of the worker
- **Database Usage**: Usage of the D1 database
- **KV Usage**: Usage of the KV namespace
- **R2 Usage**: Usage of the R2 bucket
- **Vectorize Usage**: Usage of the Vectorize index

### Capacity Planning

Capacity planning involves:

1. Monitoring resource usage trends
2. Forecasting future resource needs
3. Planning for capacity increases
4. Implementing capacity changes

### Scaling Considerations

When scaling the system, consider:

- **Worker Limits**: Cloudflare Workers limits
- **Database Limits**: D1 database limits
- **KV Limits**: KV namespace limits
- **R2 Limits**: R2 bucket limits
- **Vectorize Limits**: Vectorize index limits
- **Cost Implications**: Cost of increased capacity

## User Activity Monitoring

The system includes user activity monitoring to track user behavior and usage patterns.

### User Activity Metrics

The system tracks the following user activity metrics:

- **Active Users**: Number of active users
- **Queries per User**: Number of queries per user
- **Query Types**: Types of queries submitted
- **Tool Usage**: Usage of different tools
- **Error Rate per User**: Error rate per user

### User Activity Dashboard

User activity is displayed on the monitoring dashboard:

1. Log in to the monitoring dashboard
2. Navigate to the Chat RAG Graph section
3. Click on "User Activity"

### User Activity Analysis

User activity analysis can help:

- Identify popular features
- Detect usage patterns
- Identify problematic users
- Plan for capacity needs
- Improve the user experience

## Monitoring Best Practices

When monitoring the Chat RAG Graph solution, consider these best practices:

1. **Comprehensive Monitoring**: Monitor all aspects of the system, including performance, errors, and resource usage.

2. **Proactive Alerting**: Set up alerts to notify of issues before they affect users.

3. **Baseline Establishment**: Establish performance baselines to detect anomalies.

4. **Regular Review**: Regularly review monitoring data to identify trends and issues.

5. **Incident Correlation**: Correlate incidents with monitoring data to identify root causes.

6. **Documentation**: Document monitoring procedures and alert responses.

7. **Continuous Improvement**: Continuously improve monitoring based on operational experience.

8. **Monitoring Validation**: Regularly validate that monitoring is working correctly.

9. **Alert Tuning**: Tune alerts to minimize false positives and negatives.

10. **Monitoring Automation**: Automate monitoring tasks where possible.

## Setting Up Monitoring

### 1. Configure Logging

Ensure that logging is configured correctly:

```toml
# In wrangler.toml
[env.prod]
vars = { LOG_LEVEL = "info" }
```

### 2. Configure Metrics

Ensure that metrics collection is enabled:

```typescript
// In src/utils/metrics.ts
export function initMetrics(env: Bindings): void {
  // Initialize metrics
  env.METRICS.init({
    // Metrics configuration
  });
}
```

### 3. Configure Tracing

Ensure that tracing is configured correctly:

```typescript
// In src/utils/tracing.ts
export function initTracing(env: Bindings): void {
  // Initialize tracing
  env.TRACING.init({
    // Tracing configuration
  });
}
```

### 4. Configure Alerting

Configure alerts in the alerting system:

1. Log in to the alerting system
2. Navigate to the Chat RAG Graph section
3. Configure alert thresholds and notification channels

### 5. Configure Dashboards

Configure dashboards in the monitoring system:

1. Log in to the monitoring dashboard
2. Navigate to the Chat RAG Graph section
3. Configure dashboard panels and layouts

## Conclusion

Effective monitoring is essential for maintaining the reliability and performance of the Chat RAG Graph solution. By following the monitoring practices outlined in this guide, you can ensure that the system operates correctly and issues are detected and resolved quickly.

For more information on operating the system, see the [Operations Documentation](./README.md).
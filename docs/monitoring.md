# Dome Monitoring Guide

This document provides comprehensive information on monitoring, interpreting logs, understanding metrics, and responding to alerts across the Dome microservices architecture.

## Table of Contents

1. [Introduction](#introduction)
2. [Log Structure and Interpretation](#log-structure-and-interpretation)
3. [Common Error Types](#common-error-types)
4. [Monitoring Dashboards](#monitoring-dashboards)
5. [Alert Configuration](#alert-configuration)
6. [Troubleshooting Guide](#troubleshooting-guide)
7. [Response Procedures](#response-procedures)

## Introduction

The Dome platform uses a standardized approach to logging, metrics collection, and monitoring across all services. This unified approach enables:

- Consistent log formats across all services
- Standardized error classification and handling
- Request ID propagation for distributed tracing
- Structured operational metrics
- Comprehensive monitoring dashboards
- Actionable alerts with clear severity levels

This guide will help you understand how to leverage these capabilities to monitor, debug, and maintain the platform.

## Log Structure and Interpretation

### Log Format

All logs across Dome services follow a standardized structured JSON format, which includes these common fields:

| Field         | Description                                        | Example                               |
|---------------|----------------------------------------------------|---------------------------------------|
| `timestamp`   | ISO 8601 timestamp                                 | `2025-04-26T22:54:31.123Z`            |
| `level`       | Log level                                          | `info`, `error`, `warn`, `debug`      |
| `service`     | Service name                                       | `dome-api`, `silo`, `constellation`   |
| `component`   | Component within the service                       | `database`, `vectorize`, `controller` |
| `message`     | Human-readable message                             | `Request processed successfully`      |
| `requestId`   | Unique identifier for distributed tracing          | `f8e7d6c5-b4a3-2c1d-0e9f-8a7b6c5d4e3f`|
| `event`       | Standardized event type                            | `REQUEST_START`, `OPERATION_END`      |
| `operation`   | Name of the operation being performed              | `createUser`, `queryVectors`          |
| `duration_ms` | Operation duration in milliseconds (when applicable)| `123.45`                             |

### Log Levels

Logs use standard levels, each serving a specific purpose:

| Level   | Purpose                                                | When to Use                                     |
|---------|--------------------------------------------------------|------------------------------------------------|
| `trace` | Extremely detailed information for pinpointing issues  | Function entry/exit, variable values in loops  |
| `debug` | Detailed information useful for debugging              | Configuration values, detailed processing steps |
| `info`  | General operational information                        | Service startup, request handling, operations  |
| `warn`  | Potentially harmful situations                         | Deprecated API usage, fallbacks, retries       |
| `error` | Error conditions preventing an operation from completing | Failed requests, database errors, exceptions  |
| `fatal` | Severe error conditions preventing application function | Database connection failures, critical outages |

### Standardized Event Names

The `@dome/logging` package defines standard event names that appear in the `event` field:

| Event Name           | Description                              | Typical Log Level |
|----------------------|------------------------------------------|------------------|
| `REQUEST_START`      | Start of a request processing            | `info`           |
| `REQUEST_END`        | End of a request processing              | `info`           |
| `REQUEST_ERROR`      | Error during request processing          | `error`          |
| `OPERATION_START`    | Start of an internal operation           | `debug`          |
| `OPERATION_END`      | Successful completion of an operation    | `debug`          |
| `OPERATION_ERROR`    | Error during an operation                | `error`          |
| `EXTERNAL_CALL`      | External API or service call             | `debug`          |
| `DATABASE_QUERY`     | Database operation                       | `debug`          |
| `CACHE_HIT`          | Cache hit event                          | `debug`          |
| `CACHE_MISS`         | Cache miss event                         | `debug`          |
| `WORKER_START`       | Worker startup                           | `info`           |
| `WORKER_SHUTDOWN`    | Worker shutdown                          | `info`           |

### Reading Logs in Cloudflare Logs Engine

To query logs in Cloudflare Logs Engine:

1. Navigate to Workers & Pages → Logs in the Cloudflare dashboard
2. Select the "dome_logs" dataset
3. Use SQL queries to filter and analyze logs

**Example Queries:**

```sql
-- Query logs for a specific request ID (distributed tracing)
SELECT
  ts,
  lvl,
  service,
  msg,
  data
FROM dome_logs
WHERE requestId = 'f8e7d6c5-b4a3-2c1d-0e9f-8a7b6c5d4e3f'
ORDER BY ts ASC

-- Query for error logs in the last hour
SELECT
  ts,
  service,
  component,
  msg,
  err.name as error_type,
  err.msg as error_message,
  requestId
FROM dome_logs
WHERE lvl = 'error'
  AND ts > now() - INTERVAL 1 HOUR
ORDER BY ts DESC
LIMIT 100

-- Query for slow operations
SELECT
  requestId,
  service,
  operation,
  durMs,
  data
FROM dome_logs
WHERE event = 'OPERATION_END'
  AND durMs > 1000
  AND ts > now() - INTERVAL 1 HOUR
ORDER BY durMs DESC
LIMIT 20
```

## Common Error Types

The Dome platform uses standardized error types across all services, which are logged consistently and provide structured data for troubleshooting.

### Error Classification

Each error belongs to one of these standardized types:

| Error Type                | HTTP Status | Common Causes                                    | Metrics Tag           |
|---------------------------|-------------|--------------------------------------------------|------------------------|
| `ValidationError`         | 400         | Invalid input, failed validation rules           | `errors.validation`    |
| `BadRequestError`         | 400         | Malformed requests, missing required parameters  | `errors.badRequest`    |
| `UnauthorizedError`       | 401         | Missing or invalid authentication                | `errors.unauthorized`  |
| `ForbiddenError`          | 403         | Insufficient permissions                         | `errors.forbidden`     |
| `NotFoundError`           | 404         | Resource not found                              | `errors.notFound`      |
| `ConflictError`           | 409         | Resource conflicts, duplicate entries            | `errors.conflict`      |
| `RateLimitError`          | 429         | Rate limit exceeded                             | `errors.rateLimit`     |
| `InternalError`           | 500         | Unexpected server errors                        | `errors.internal`      |
| `ServiceUnavailableError` | 503         | Temporary unavailability, maintenance           | `errors.serviceUnavailable` |

### Error Structure

Error logs include standardized fields:

```json
{
  "timestamp": "2025-04-26T15:30:12.345Z",
  "level": "error",
  "service": "dome-api",
  "component": "userController",
  "message": "Failed to create user",
  "requestId": "f8e7d6c5-b4a3-2c1d-0e9f-8a7b6c5d4e3f",
  "err": {
    "name": "ValidationError",
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": {
      "field": "email",
      "operation": "createUser"
    },
    "stack": "ValidationError: Email is required\n    at validateUser (userService.ts:45)..."
  }
}
```

### Common Error Meanings and Implications

| Error Type                | Business Impact                                   | Typical Response                                      |
|---------------------------|---------------------------------------------------|------------------------------------------------------|
| `ValidationError`         | Client-side issue, no data impact                 | Review and fix client requests                        |
| `BadRequestError`         | Client integration issues                         | Review API documentation and client implementations   |
| `UnauthorizedError`       | Security concern if unexpected                    | Check authentication systems, token expiration        |
| `ForbiddenError`          | Security or permission configuration issue        | Review access control policies                        |
| `NotFoundError`           | Data consistency issue if resource should exist   | Check data integrity, database indexes                |
| `ConflictError`           | Duplicate requests or race conditions             | Review client retry logic, check for duplicate submissions |
| `RateLimitError`          | Client sending too many requests                  | Implement backoff strategies, review client patterns  |
| `InternalError`           | Server-side issue requiring attention             | Investigate logs, review recent changes, check dependencies |
| `ServiceUnavailableError` | Downstream dependency or scaling issue            | Check system health, dependency status, scaling needs |

## Monitoring Dashboards

Dome uses standardized monitoring dashboards for all services. The dashboards are organized into logical panels that provide insights into different aspects of service health and performance.

### Dashboard Structure

Each service dashboard includes panels for:

1. **Request Metrics**: Volume, duration, success rates
2. **Error Metrics**: Error counts by type and component
3. **Operation Metrics**: Duration of key operations
4. **Resource Utilization**: CPU, memory, and other resources
5. **Service-specific Metrics**: Custom metrics relevant to each service

### Key Dashboard Panels

#### Request Lifecycle

This panel shows metrics related to HTTP requests:

- Request counts
- Request durations (min, avg, max)
- Success and error rates
- Response status code distribution

#### Error Rates by Type

This panel displays error counts broken down by error type:

- ValidationError count
- NotFoundError count
- InternalError count
- Other error types

#### Operation Durations

This panel shows the execution time of key operations:

- Average duration for critical operations
- 95th and 99th percentile durations
- Operation success and failure rates

### How to Use Dashboards Effectively

1. **Start with overviews**: Begin with high-level metrics like request volume and error rates
2. **Drill down into issues**: When anomalies are detected, drill down into specific metrics
3. **Correlate related metrics**: Look for patterns across different panels
4. **Compare to baselines**: Compare current metrics to historical baselines
5. **Time alignment**: Use time selectors to align with when issues were reported

### Dashboard Access

To access the dashboards:

1. Log in to the Cloudflare dashboard
2. Navigate to Workers & Pages → Monitoring
3. Select the service you want to monitor
4. Choose the appropriate dashboard from the dropdown

## Alert Configuration

Alerts are configured to notify the team when metrics exceed predefined thresholds. Each alert has a specific purpose, severity level, and notification channels.

### Alert Structure

Each alert definition includes:

- **Name**: Brief, descriptive name of the alert
- **Description**: More detailed description of what the alert means
- **Metric**: The metric being monitored
- **Condition**: Threshold that triggers the alert
- **Duration**: How long the condition must be true to trigger the alert
- **Severity**: Warning or critical
- **Notification Channels**: Where alerts are sent (email, Slack, PagerDuty)
- **Message**: The alert message with actionable information

### Severity Levels

| Severity  | Description                                             | Response Time      | Notification Channels          |
|-----------|---------------------------------------------------------|-------------------|--------------------------------|
| `warning` | Potential issue that requires attention but not urgent  | Within 4 hours    | Email, Slack                   |
| `critical`| Serious issue that requires immediate attention         | Within 30 minutes | Email, Slack, PagerDuty        |

### Alert Thresholds Explained

#### Error Rate Alerts

| Alert                    | Threshold            | Justification                                      |
|--------------------------|----------------------|----------------------------------------------------|
| High Queue Error Rate    | > 10 in 5 minutes    | Indicates persistent processing issues             |
| Embedding Errors         | > 5 in 5 minutes     | Potential AI service issues                        |
| Critical Internal Errors | > 5 in 2 minutes     | Server-side issues requiring immediate attention   |
| Service Unavailable      | > 0 in 1 minute      | Dependency outage requiring immediate action       |

#### Duration Alerts

| Alert                     | Threshold         | Justification                                        |
|---------------------------|-------------------|------------------------------------------------------|
| Slow Embedding            | > 8000ms (8s)     | AI service performance degradation                   |
| Slow Vectorize Operations | > 3000ms (3s)     | Vector database performance issues                   |
| Slow Queries              | > 2000ms (2s)     | Query optimization or index issues                   |
| Slow Batch Processing     | > 10000ms (10s)   | Batch processing bottlenecks                         |

#### System Resource Alerts

| Alert                    | Threshold          | Justification                                        |
|--------------------------|--------------------|----------------------------------------------------|
| High CPU Usage           | > 80% for 5 minutes | Approaching resource limits, potential scaling needed |
| High Memory Usage        | > 80% for 5 minutes | Potential memory leaks or need for scaling           |

## Troubleshooting Guide

This section provides guidance on how to investigate and address common issues using the logs and metrics.

### General Troubleshooting Approach

1. **Identify the issue**: Use dashboards and alerts to identify the problem area
2. **Gather context**: Find related logs using request IDs and time ranges
3. **Analyze logs**: Look for error patterns and related events
4. **Check metrics**: Correlate logs with metrics to understand impact
5. **Determine root cause**: Use error details and stack traces
6. **Apply fix**: Implement the appropriate solution
7. **Verify resolution**: Confirm metrics return to normal

### Troubleshooting by Error Type

#### ValidationError

**Potential Causes**:
- Client sending invalid data
- Recent API changes not reflected in client implementation
- Schema validation rules too strict

**Investigation Steps**:
1. Check error details for specific validation failures
2. Review recent API changes
3. Verify client implementation

**Resolution Approaches**:
- Update client implementation
- Adjust validation rules if appropriate
- Improve API documentation

#### NotFoundError

**Potential Causes**:
- Resource deleted or never existed
- Database index issues
- Cache inconsistency
- Data integrity problems

**Investigation Steps**:
1. Verify resource ID in request
2. Check database directly for the resource
3. Look for recent delete operations
4. Check for cache inconsistencies

**Resolution Approaches**:
- Update client to handle missing resources
- Restore data if accidentally deleted
- Fix cache synchronization issues

#### InternalError

**Potential Causes**:
- Unhandled exceptions in code
- Database connection issues
- Out of memory conditions
- Dependency failures

**Investigation Steps**:
1. Check error stack trace
2. Look for patterns in affected operations
3. Review recent deployments
4. Check system resources
5. Verify dependency health

**Resolution Approaches**:
- Fix code bugs
- Scale resources if needed
- Address dependency issues
- Implement better error handling

#### ServiceUnavailableError

**Potential Causes**:
- Downstream service outage
- Rate limiting by dependencies
- Planned maintenance
- Resource exhaustion

**Investigation Steps**:
1. Check status of all dependencies
2. Review rate limits and quotas
3. Check for planned maintenance
4. Monitor resource utilization

**Resolution Approaches**:
- Wait for dependency recovery
- Implement circuit breakers
- Adjust rate limiting
- Scale resources

### Troubleshooting Performance Issues

#### Slow Operations

**Potential Causes**:
- Inefficient algorithms
- Missing database indexes
- Resource contention
- External service latency
- Network issues

**Investigation Steps**:
1. Identify slow operations in logs
2. Check operation parameters
3. Look for patterns in slow operations
4. Monitor resource utilization
5. Check external service performance

**Resolution Approaches**:
- Optimize code
- Add or fix database indexes
- Scale resources
- Implement caching
- Adjust timeouts and retries

#### High Error Rates

**Potential Causes**:
- Code bugs
- Configuration issues
- External dependency failures
- Resource exhaustion
- Security incidents

**Investigation Steps**:
1. Analyze error patterns
2. Check recent deployments
3. Verify configuration
4. Monitor external dependencies
5. Check for unusual access patterns

**Resolution Approaches**:
- Roll back recent changes
- Fix bugs
- Update configuration
- Implement circuit breakers
- Scale resources
- Address security issues

## Response Procedures

This section outlines the procedures to follow when responding to alerts.

### Alert Response Process

1. **Acknowledge**: Acknowledge the alert to indicate someone is investigating
2. **Assess**: Determine the severity and potential impact
3. **Investigate**: Follow the troubleshooting guide to identify the cause
4. **Communicate**: Keep stakeholders informed of progress
5. **Resolve**: Implement a fix or mitigation
6. **Document**: Document the incident, cause, and resolution
7. **Follow up**: Implement preventative measures

### Response by Alert Severity

#### Warning Alerts

- Acknowledge within 30 minutes
- Investigate within 4 hours
- Resolve within 24 hours
- Document within 48 hours

#### Critical Alerts

- Acknowledge within 5 minutes
- Investigate immediately
- Provide status updates every 30 minutes
- Escalate if not resolved within 2 hours
- Document within 24 hours
- Conduct post-incident review

### Escalation Procedures

#### Level 1: On-Call Engineer

- Responsible for initial response
- Has 30 minutes to acknowledge critical alerts
- Can resolve most issues independently

#### Level 2: Engineering Lead

- Escalate if on-call engineer cannot resolve
- Coordinates team response for complex issues
- Decides on mitigation strategies

#### Level 3: Technical Management

- Escalate for severe outages or data loss
- Coordinates cross-team response
- Makes business impact decisions
- Communicates with executive leadership

### Communication Channels

- **Slack**: #dome-alerts for initial notifications
- **PagerDuty**: For critical alerts and escalations
- **Email**: For non-urgent updates and summaries
- **Incident Management System**: For tracking and documentation

## Conclusion

This monitoring documentation provides a comprehensive guide to understanding the logs, metrics, and alerts in the Dome platform. By following these guidelines, you can effectively monitor system health, troubleshoot issues, and ensure reliable service operation.

For additional details on logging implementation, refer to the [Logging Standards](./standards/logging.md) and [Error Handling Standards](./standards/error-handling.md) documentation.
# Constellation Migration Plan

This document outlines the steps to deploy the Constellation embedding service and migrate from the current embedding approach to the new service.

## 1. Deployment Steps

### 1.1 Initial Deployment

1. **Create Vectorize Indexes**:

   ```bash
   # Create the production index
   wrangler vectorize create dome-notes-prod --dimensions=384

   # Create metadata indexes for filtering
   wrangler vectorize create-metadata-index dome-notes-prod --property-name userId --type string
   wrangler vectorize create-metadata-index dome-notes-prod --property-name noteId --type string
   wrangler vectorize create-metadata-index dome-notes-prod --property-name version --type number

   # Repeat for staging environment
   wrangler vectorize create dome-notes-staging --dimensions=384
   wrangler vectorize create-metadata-index dome-notes-staging --property-name userId --type string
   wrangler vectorize create-metadata-index dome-notes-staging --property-name noteId --type string
   wrangler vectorize create-metadata-index dome-notes-staging --property-name version --type number
   ```

2. **Create Queues**:

   ```bash
   # Create the production queues
   wrangler queues create embed-queue
   wrangler queues create embed-dead-letter-prod

   # Create the staging queues
   wrangler queues create embed-queue --env staging
   wrangler queues create embed-dead-letter-staging
   ```

3. **Deploy the Constellation Service**:

   ```bash
   # Deploy to staging first
   cd services/constellation
   wrangler deploy --env staging

   # After verification, deploy to production
   wrangler deploy --env production
   ```

4. **Verify Deployment**:

   ```bash
   # Check if the service is running and can access its bindings
   wrangler tail constellation --env staging

   # Test the stats endpoint
   curl "https://constellation-staging.example.com/stats"
   ```

### 1.2 Monitoring Setup

1. **Set Up Alerts**:

   - Configure alerts based on the `monitoring/alerts.yaml` file
   - Set up notification channels for email, Slack, and PagerDuty

2. **Dashboard Setup**:
   - Create a monitoring dashboard for the Constellation service
   - Include metrics for queue depth, processing time, error rates, etc.

## 2. Migration Strategy

### 2.1 Phased Migration

We'll use a phased approach to migrate from the current embedding implementation to the Constellation service:

#### Phase 1: Parallel Write (1 week)

1. **Update Producer Services**:

   - Modify API worker to write to both the old system and the new embed-queue
   - Modify import workers (GitHub, Notion) to write to both systems
   - Keep reads going to the old system

2. **Monitoring**:
   - Monitor queue depth and processing rates
   - Verify data consistency between old and new systems
   - Adjust batch sizes and concurrency as needed

#### Phase 2: Read Migration (1 week)

1. **Update Consumer Services**:

   - Modify services to read from both systems and compare results
   - Log any discrepancies for investigation
   - Gradually increase traffic to the new system (20% → 50% → 80%)

2. **Monitoring**:
   - Monitor query performance and result quality
   - Track any errors or inconsistencies

#### Phase 3: Full Cutover (1 day)

1. **Complete Migration**:

   - Switch all reads to the new system
   - Continue writing to both systems temporarily

2. **Verification**:
   - Verify all functionality is working correctly
   - Run comprehensive tests on the new system

#### Phase 4: Cleanup (1 week)

1. **Remove Old System**:

   - Stop writing to the old system
   - Archive old data if needed
   - Remove old code paths

2. **Documentation**:
   - Update all documentation to reflect the new system
   - Conduct knowledge transfer sessions if needed

### 2.2 Integration Points

The following services need to be updated to use the Constellation service:

1. **API Worker**:

   - Update to enqueue embedding jobs instead of inline embedding
   - Replace direct Vectorize calls with Constellation RPC calls

2. **GitHub Cron Worker**:

   - Update to enqueue embedding jobs for repository content
   - Use Constellation for vector searches

3. **Notion Cron Worker**:
   - Update to enqueue embedding jobs for Notion content
   - Use Constellation for vector searches

## 3. Rollback Procedures

In case of issues, we have the following rollback procedures:

### 3.1 Quick Rollback

If issues are detected during the migration phases:

1. **Revert to Old System**:

   - Switch all reads back to the old system
   - Continue writing to both systems to avoid data loss

2. **Disable Queue Consumer**:
   - Temporarily disable the Constellation queue consumer
   - This prevents processing new jobs while investigating issues

### 3.2 Full Rollback

If critical issues require a complete rollback:

1. **Revert Code Changes**:

   - Roll back all code changes in producer and consumer services
   - Deploy the reverted code to production

2. **Service Removal**:
   - If necessary, remove the Constellation service deployment
   - Keep the Vectorize indexes and queues for future retry

### 3.3 Data Recovery

If data inconsistency is detected:

1. **Identify Affected Data**:

   - Use logging to identify affected users and notes
   - Compare vector data between old and new systems

2. **Reprocess Data**:
   - Requeue affected notes for embedding
   - Verify data consistency after reprocessing

## 4. Post-Migration Tasks

After successful migration:

1. **Performance Optimization**:

   - Fine-tune batch sizes and concurrency
   - Optimize preprocessing for better performance
   - Adjust retry strategies based on production patterns

2. **Monitoring Refinement**:

   - Adjust alert thresholds based on production patterns
   - Create additional dashboards as needed

3. **Documentation Update**:
   - Finalize all documentation
   - Create runbooks for common operational tasks

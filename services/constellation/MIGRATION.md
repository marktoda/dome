# Constellation Migration Guide

This document provides comprehensive guidance for deploying the Constellation embedding service and migrating from the previous embedding approach to the new service. It includes detailed steps, code examples, and best practices to ensure a smooth transition.

## Table of Contents

- [Constellation Migration Guide](#constellation-migration-guide)
  - [Table of Contents](#table-of-contents)
  - [1. Deployment Steps](#1-deployment-steps)
    - [1.1 Initial Deployment](#11-initial-deployment)
    - [1.2 Monitoring Setup](#12-monitoring-setup)
  - [2. Migration Strategy](#2-migration-strategy)
    - [2.1 Phased Migration](#21-phased-migration)
      - [Phase 1: Parallel Write (1 week)](#phase-1-parallel-write-1-week)
      - [Phase 2: Read Migration (1 week)](#phase-2-read-migration-1-week)
      - [Phase 3: Full Cutover (1 day)](#phase-3-full-cutover-1-day)
      - [Phase 4: Cleanup (1 week)](#phase-4-cleanup-1-week)
    - [2.2 Integration Points](#22-integration-points)
  - [3. Rollback Procedures](#3-rollback-procedures)
    - [3.1 Quick Rollback](#31-quick-rollback)
    - [3.2 Full Rollback](#32-full-rollback)
    - [3.3 Data Recovery](#33-data-recovery)
  - [4. Post-Migration Tasks](#4-post-migration-tasks)
  - [5. Embedding Model Version Migration](#5-embedding-model-version-migration)
  - [6. Troubleshooting](#6-troubleshooting)
    - [Queue Processing Issues](#queue-processing-issues)
    - [Embedding Errors](#embedding-errors)
    - [Query Performance Issues](#query-performance-issues)
    - [Data Consistency Issues](#data-consistency-issues)

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

   **Verification**: After creating indexes, verify they exist and have the correct configuration:

   ```bash
   # Verify production index
   wrangler vectorize describe dome-notes-prod

   # Verify staging index
   wrangler vectorize describe dome-notes-staging
   ```

2. **Create Queues**:

   ```bash
   # Create the production queues
   wrangler queues create embed-queue-prod
   wrangler queues create embed-dead-letter-prod

   # Create the staging queues
   wrangler queues create embed-queue-staging
   wrangler queues create embed-dead-letter-staging

   # Create the development queues (if needed)
   wrangler queues create embed-queue
   wrangler queues create embed-dead-letter
   ```

   **Verification**: Confirm the queues were created successfully:

   ```bash
   # List all queues
   wrangler queues list
   ```

3. **Deploy the Constellation Service**:

   ```bash
   # Deploy to staging first
   cd services/constellation
   wrangler deploy --env staging

   # After verification, deploy to production
   wrangler deploy --env production
   ```

   **Deployment Verification Checklist**:

   - [ ] Service deploys without errors
   - [ ] All bindings are correctly configured
   - [ ] Service can access Vectorize index
   - [ ] Service can access Workers AI
   - [ ] Queue consumer is functioning

4. **Verify Deployment**:

   ```bash
   # Check if the service is running and can access its bindings
   wrangler tail constellation --env staging

   # Test the stats endpoint
   curl "https://constellation-staging.example.com/stats"

   # Test with a sample embedding job
   curl -X POST "https://constellation-staging.example.com/embed" \
     -H "Content-Type: application/json" \
     -d '{"userId":"test","noteId":"test-note","text":"Test embedding","created":1650000000000,"version":1}'
   ```

### 1.2 Monitoring Setup

1. **Set Up Alerts**:

   - Configure alerts based on the `monitoring/alerts.yaml` file
   - Set up notification channels for email, Slack, and PagerDuty

   **Key Metrics to Monitor**:

   - Queue depth (alert if > 1000 for > 15 minutes)
   - Error rate (alert if > 5% for > 5 minutes)
   - Processing latency (alert if p95 > 2000ms for > 10 minutes)
   - Dead letter queue size (alert on any messages)

2. **Dashboard Setup**:
   - Create a monitoring dashboard for the Constellation service
   - Include the following panels:
     - Queue depth over time
     - Processing time (p50, p95, p99)
     - Error rates by type
     - Embedding batch sizes
     - Vector upsert batch sizes
     - Query response times
     - Index size growth

## 2. Migration Strategy

### 2.1 Phased Migration

We'll use a phased approach to migrate from the current embedding implementation to the Constellation service:

#### Phase 1: Parallel Write (1 week)

1. **Update Producer Services**:

   - Modify API worker to write to both the old system and the new embed-queue

   ```typescript
   // Example code for API worker
   async function handleNoteCreation(note, env) {
     // Old system
     try {
       await oldEmbeddingSystem.embed(note);
     } catch (error) {
       logger.error({ error }, 'Error embedding note in old system');
     }

     // New system (Constellation)
     try {
       await env.QUEUE.send('embed-queue-prod', {
         userId: note.userId,
         noteId: note.id,
         text: note.content,
         created: Date.now(),
         version: 1,
       });
     } catch (error) {
       logger.error({ error }, 'Error enqueueing note for embedding');
     }
   }
   ```

   - Modify import workers (GitHub, Notion) to write to both systems
   - Keep reads going to the old system

2. **Monitoring**:

   - Monitor queue depth and processing rates
   - Verify data consistency between old and new systems
   - Adjust batch sizes and concurrency as needed

   **Data Consistency Check**:

   ```typescript
   // Example consistency check script
   async function checkConsistency(sampleSize = 100) {
     const notes = await db.getNotes().limit(sampleSize);

     for (const note of notes) {
       const oldResults = await oldEmbeddingSystem.search(note.content, { userId: note.userId });
       const newResults = await env.CONSTELLATION.query(note.content, { userId: note.userId });

       // Compare results
       const overlap = calculateResultOverlap(oldResults, newResults);
       logger.info({ noteId: note.id, overlap }, 'Consistency check');

       if (overlap < 0.7) {
         logger.warn({ noteId: note.id, oldResults, newResults }, 'Low consistency detected');
       }
     }
   }
   ```

#### Phase 2: Read Migration (1 week)

1. **Update Consumer Services**:

   - Modify services to read from both systems and compare results

   ```typescript
   // Example code for search service
   async function searchNotes(query, userId, env) {
     // Get results from old system
     const oldResults = await oldEmbeddingSystem.search(query, { userId });

     // Get results from new system
     const newResults = await env.CONSTELLATION.query(query, { userId });

     // Log comparison for analysis
     logger.info(
       {
         query,
         oldResultCount: oldResults.length,
         newResultCount: newResults.length,
         overlap: calculateResultOverlap(oldResults, newResults),
       },
       'Search comparison',
     );

     // During migration, use traffic splitting based on configuration
     const useNewSystem = Math.random() < env.NEW_SYSTEM_TRAFFIC_PERCENTAGE;
     return useNewSystem ? newResults : oldResults;
   }
   ```

   - Log any discrepancies for investigation
   - Gradually increase traffic to the new system (20% → 50% → 80%)

   **Traffic Splitting Configuration**:

   ```toml
   # wrangler.toml
   [env.production.vars]
   NEW_SYSTEM_TRAFFIC_PERCENTAGE = 0.2  # Start with 20%
   ```

2. **Monitoring**:
   - Monitor query performance and result quality
   - Track any errors or inconsistencies
   - Set up dashboards comparing old vs. new system metrics

#### Phase 3: Full Cutover (1 day)

1. **Complete Migration**:

   - Switch all reads to the new system

   ```typescript
   // Update configuration
   // wrangler.toml
   [env.production.vars]
   NEW_SYSTEM_TRAFFIC_PERCENTAGE = 1.0  # 100% on new system
   ```

   - Continue writing to both systems temporarily as a safety measure

2. **Verification**:

   - Verify all functionality is working correctly
   - Run comprehensive tests on the new system

   **Verification Checklist**:

   - [ ] All queries return expected results
   - [ ] Performance meets or exceeds old system
   - [ ] Error rates are within acceptable thresholds
   - [ ] All integrations are functioning correctly

#### Phase 4: Cleanup (1 week)

1. **Remove Old System**:

   - Stop writing to the old system

   ```typescript
   // Remove old system code
   async function handleNoteCreation(note, env) {
     // Only use new system (Constellation)
     await env.QUEUE.send('embed-queue-prod', {
       userId: note.userId,
       noteId: note.id,
       text: note.content,
       created: Date.now(),
       version: 1,
     });
   }
   ```

   - Archive old data if needed
   - Remove old code paths

2. **Documentation**:
   - Update all documentation to reflect the new system
   - Conduct knowledge transfer sessions if needed
   - Create runbooks for common operational tasks

### 2.2 Integration Points

The following services need to be updated to use the Constellation service:

1. **API Worker**:

   - Update to enqueue embedding jobs instead of inline embedding

   ```typescript
   // Before
   async function createNote(request, env) {
     const note = await request.json();

     // Inline embedding
     const embedding = await generateEmbedding(note.content);
     await storeEmbedding(note.id, embedding);

     return new Response('Note created');
   }

   // After
   async function createNote(request, env) {
     const note = await request.json();

     // Enqueue for async embedding
     await env.QUEUE.send('embed-queue-prod', {
       userId: note.userId,
       noteId: note.id,
       text: note.content,
       created: Date.now(),
       version: 1,
     });

     return new Response('Note created');
   }
   ```

   - Replace direct Vectorize calls with Constellation RPC calls

   ```typescript
   // Before
   async function searchNotes(request, env) {
     const { query, userId } = await request.json();

     const embedding = await generateEmbedding(query);
     const results = await env.VECTORIZE.query(embedding, {
       filter: { userId },
       topK: 10,
     });

     return new Response(JSON.stringify(results));
   }

   // After
   async function searchNotes(request, env) {
     const { query, userId } = await request.json();

     const results = await env.CONSTELLATION.query(query, { userId }, 10);

     return new Response(JSON.stringify(results));
   }
   ```

2. **GitHub Cron Worker**:

   - Update to enqueue embedding jobs for repository content

   ```typescript
   // Before
   async function processRepositoryContent(content, env) {
     const embedding = await generateEmbedding(content.text);
     await storeEmbedding(content.id, embedding);
   }

   // After
   async function processRepositoryContent(content, env) {
     await env.QUEUE.send('embed-queue-prod', {
       userId: content.userId,
       noteId: content.id,
       text: content.text,
       created: Date.now(),
       version: 1,
     });
   }
   ```

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

   ```typescript
   // Update configuration
   // wrangler.toml
   [env.production.vars]
   NEW_SYSTEM_TRAFFIC_PERCENTAGE = 0.0  # 0% on new system
   ```

   - Continue writing to both systems to avoid data loss

2. **Disable Queue Consumer**:

   - Temporarily disable the Constellation queue consumer

   ```bash
   # Disable queue consumer in production
   wrangler queues consumer disable embed-queue-prod
   ```

   - This prevents processing new jobs while investigating issues

### 3.2 Full Rollback

If critical issues require a complete rollback:

1. **Revert Code Changes**:

   - Roll back all code changes in producer and consumer services
   - Deploy the reverted code to production

   ```bash
   # Example git rollback
   git checkout <previous-commit-hash>
   wrangler deploy --env production
   ```

2. **Service Removal**:

   - If necessary, remove the Constellation service deployment

   ```bash
   # Remove service (if necessary)
   wrangler delete constellation --env production
   ```

   - Keep the Vectorize indexes and queues for future retry

### 3.3 Data Recovery

If data inconsistency is detected:

1. **Identify Affected Data**:

   - Use logging to identify affected users and notes

   ```bash
   # Search logs for errors
   wrangler tail constellation --env production | grep "Error embedding note"
   ```

   - Compare vector data between old and new systems

   ```typescript
   // Example comparison script
   async function compareVectorData(userId, noteId) {
     const oldVector = await oldEmbeddingSystem.getVector(userId, noteId);
     const newResults = await env.CONSTELLATION.query(
       '', // Empty query to get exact match
       { userId, noteId },
       1,
     );

     return {
       oldExists: !!oldVector,
       newExists: newResults.length > 0,
       match: newResults.length > 0 && newResults[0].metadata.noteId === noteId,
     };
   }
   ```

2. **Reprocess Data**:

   - Requeue affected notes for embedding

   ```typescript
   // Requeue affected notes
   async function requeueNote(userId, noteId) {
     const note = await db.getNote(userId, noteId);

     if (note) {
       await env.QUEUE.send('embed-queue-prod', {
         userId,
         noteId,
         text: note.content,
         created: note.createdAt,
         version: 1,
       });
       logger.info({ userId, noteId }, 'Requeued note for embedding');
     }
   }
   ```

   - Verify data consistency after reprocessing

## 4. Post-Migration Tasks

After successful migration:

1. **Performance Optimization**:

   - Fine-tune batch sizes and concurrency

   ```toml
   # wrangler.toml
   [env.production.queues]
   consumers = [
     { queue = "embed-queue-prod", max_batch_size = 20, max_batch_timeout = 30, max_retries = 3, max_concurrency = 10 }
   ]
   ```

   - Optimize preprocessing for better performance
   - Adjust retry strategies based on production patterns

2. **Monitoring Refinement**:

   - Adjust alert thresholds based on production patterns
   - Create additional dashboards as needed
   - Set up regular health checks

3. **Documentation Update**:
   - Finalize all documentation
   - Create runbooks for common operational tasks
   - Document lessons learned during migration

## 5. Embedding Model Version Migration

The Constellation service supports versioning of embedding models. When upgrading to a new embedding model:

1. **Update the Version Number**:

   ```typescript
   // Update version in embedding jobs
   await env.QUEUE.send('embed-queue-prod', {
     userId: note.userId,
     noteId: note.id,
     text: note.content,
     created: Date.now(),
     version: 2, // Incremented version
   });
   ```

2. **Dual-Version Query Strategy**:

   During the transition period, implement a strategy to query both versions:

   ```typescript
   async function searchWithDualVersions(query, userId, env) {
     // Query old version
     const oldVersionResults = await env.CONSTELLATION.query(query, { userId, version: 1 }, 10);

     // Query new version
     const newVersionResults = await env.CONSTELLATION.query(query, { userId, version: 2 }, 10);

     // Combine results with preference for new version
     const combinedResults = mergeAndDeduplicate(newVersionResults, oldVersionResults);
     return combinedResults.slice(0, 10);
   }
   ```

3. **Reprocessing Strategy**:

   To update existing notes with the new embedding version:

   ```typescript
   async function reprocessWithNewVersion(env) {
     const notes = await db.getAllNotes();

     for (const note of notes) {
       await env.QUEUE.send('embed-queue-prod', {
         userId: note.userId,
         noteId: note.id,
         text: note.content,
         created: note.createdAt,
         version: 2, // New version
       });
     }
   }
   ```

## 6. Troubleshooting

Common issues and their solutions:

### Queue Processing Issues

**Symptom**: High queue depth, slow processing

**Solutions**:

- Increase `max_concurrency` in wrangler.toml
- Increase `max_batch_size` for more efficient processing
- Check Workers AI rate limits and adjust accordingly

### Embedding Errors

**Symptom**: Errors in embedding generation

**Solutions**:

- Verify Workers AI service status
- Check for malformed input data
- Ensure text preprocessing is working correctly
- Implement better error handling for specific error types

### Query Performance Issues

**Symptom**: Slow query responses

**Solutions**:

- Use metadata filters to narrow search scope
- Verify index size and dimension
- Check for slow network conditions
- Optimize query text preprocessing

### Data Consistency Issues

**Symptom**: Different results between old and new systems

**Solutions**:

- Compare embedding vectors directly
- Check for differences in preprocessing
- Verify metadata is correctly stored
- Ensure query parameters are consistent between systems

# Cloudflare Infrastructure as Code with Pulumi

## Table of Contents

- [Overview](#overview)
- [Cloudflare Resources](#cloudflare-resources)
- [Pulumi Project Structure](#pulumi-project-structure)
- [Technology Stack](#technology-stack)
- [Dependencies and Prerequisites](#dependencies-and-prerequisites)
- [Migration Strategy](#migration-strategy)
- [Implementation Plan](#implementation-plan)
- [Best Practices](#best-practices)
- [Security Considerations](#security-considerations)
- [Monitoring and Maintenance](#monitoring-and-maintenance)

## Overview

This document outlines the architecture and implementation plan for managing Cloudflare resources using Pulumi as our Infrastructure as Code (IaC) solution. The goal is to transition from manual deployments to a fully automated, version-controlled infrastructure deployment process that aligns with our existing development workflows.

Pulumi provides several advantages for our Cloudflare infrastructure:

1. **TypeScript Support**: Aligns with our existing codebase
2. **Fine-grained Control**: Detailed management of Cloudflare resources
3. **State Management**: Reliable tracking of infrastructure state
4. **Environment Separation**: Clear distinction between dev, staging, and production
5. **Integration with CI/CD**: Automated infrastructure deployments

## Cloudflare Resources

Based on analysis of our current infrastructure, we need to manage the following Cloudflare resources:

### Workers

| Worker Name | Description | Dependencies |
|-------------|-------------|--------------|
| dome-api | Primary API interface for client applications | CONSTELLATION, SILO, AI |
| silo | Unified content storage worker | DB, BUCKET, Queues |
| constellation | Vector embedding service | VECTORIZE, SILO, AI, Queues |
| ai-processor | AI processing service | SILO, AI, Queues |
| dome-cron | Scheduled task service | D1_DATABASE, Queues |
| dome-notify | Notification service | - |

### D1 Databases

| Database Name | ID | Description | Used By |
|---------------|-------|-------------|---------|
| dome-meta | ac198406-1036-495e-b0f1-b61f7c9ecbdf | Metadata storage | dome-api, dome-cron |
| silo | baf652ea-e575-4019-b95c-c9d44d02c1aa | Content metadata storage | silo |

### R2 Buckets

| Bucket Name | Description | Used By |
|-------------|-------------|---------|
| dome-raw | Raw file storage | Multiple services |
| silo-content | Content storage for silo service | silo |

### Vectorize Indexes

| Index Name | Description | Used By |
|------------|-------------|---------|
| dome-notes | Vector storage for notes | constellation |

### Queues

| Queue Name | Description | Producers | Consumers |
|------------|-------------|-----------|-----------|
| new-content-constellation | New content for embedding | silo | constellation |
| new-content-ai | New content for AI processing | silo | ai-processor |
| content-events | R2 object creation events | R2 | silo |
| enriched-content | Processed content with AI enrichments | ai-processor | silo |
| dome-events | System events | Multiple | dome-notify, dome-cron |
| embed-dead-letter | Failed embedding jobs | constellation | - |

### Workers AI Bindings

Multiple services use Workers AI bindings for AI model access.

### Service Bindings

| Service | Binds To | Environment |
|---------|----------|-------------|
| dome-api | constellation | production, staging |
| dome-api | silo | production, staging |
| constellation | silo | production, staging |
| ai-processor | silo | production, staging |

### Cron Triggers

| Service | Schedule | Description |
|---------|----------|-------------|
| dome-cron | */5 * * * * | Runs every 5 minutes |

### Observability Settings

Most services have observability enabled with a head sampling rate of 1.

## Pulumi Project Structure

We will organize our Pulumi project in the `./infra/` directory with the following structure:

```
infra/
├── package.json
├── tsconfig.json
├── Pulumi.yaml                # Main project file
├── Pulumi.dev.yaml            # Dev stack configuration
├── Pulumi.staging.yaml        # Staging stack configuration
├── Pulumi.prod.yaml           # Production stack configuration
├── index.ts                   # Main entry point
├── src/
│   ├── config.ts              # Configuration and environment variables
│   ├── resources/
│   │   ├── workers.ts         # Workers definitions
│   │   ├── databases.ts       # D1 database definitions
│   │   ├── storage.ts         # R2 bucket definitions
│   │   ├── vectorize.ts       # Vectorize index definitions
│   │   ├── queues.ts          # Queue definitions
│   │   └── bindings.ts        # Service bindings
│   ├── stacks/
│   │   ├── dev.ts             # Dev environment specifics
│   │   ├── staging.ts         # Staging environment specifics
│   │   └── prod.ts            # Production environment specifics
│   └── utils/
│       ├── naming.ts          # Resource naming utilities
│       └── tags.ts            # Tagging utilities
└── scripts/
    ├── import-existing.ts     # Script to import existing resources
    └── validate.ts            # Validation script
```

## Technology Stack

Our Pulumi implementation will use the following technology stack:

1. **Programming Language**: TypeScript
   - Aligns with our existing codebase
   - Provides type safety and IDE support
   - Enables code reuse between infrastructure and application

2. **Pulumi Provider**: Cloudflare Provider
   - `@pulumi/cloudflare` package for Cloudflare resource management
   - Latest version to support all required resources

3. **State Management**: Pulumi Service
   - Centralized state management
   - Team collaboration features
   - Secure secrets management

4. **Additional Libraries**:
   - `@pulumi/pulumi` for core Pulumi functionality
   - `@pulumi/command` for running CLI commands when needed
   - `dotenv` for local environment variable management

## Dependencies and Prerequisites

To implement and use this Pulumi infrastructure, the following dependencies and prerequisites are required:

1. **Pulumi CLI**: Version 3.0.0 or higher
   - Installation: `curl -fsSL https://get.pulumi.com | sh`
   - Verify: `pulumi version`

2. **Cloudflare API Token**:
   - Create a token with the following permissions:
     - Account.Workers Scripts:Edit
     - Account.Workers Routes:Edit
     - Account.Workers KV Storage:Edit
     - Account.Workers Queues:Edit
     - Account.Workers D1:Edit
     - Account.R2:Edit
     - Account.Vectorize:Edit

3. **Node.js**: Version 18.x or higher
   - Required for TypeScript execution

4. **pnpm**: For package management
   - Consistent with the rest of the project

5. **Cloudflare Account Details**:
   - Account ID
   - Zone ID (if applicable)

6. **Environment Variables**:
   - `CLOUDFLARE_API_TOKEN`: Cloudflare API token
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID

## Migration Strategy

Transitioning from manual deployments to IaC requires a careful migration strategy to avoid disruption. We will follow this phased approach:

### Phase 1: Resource Discovery and Documentation

1. **Inventory Existing Resources**:
   - Document all Cloudflare resources currently in use
   - Identify resource relationships and dependencies
   - Capture current configuration settings

2. **Define Resource Naming Convention**:
   - Establish consistent naming patterns
   - Document existing names that don't follow conventions

3. **Create Resource Diagrams**:
   - Visualize resource relationships
   - Identify potential migration challenges

### Phase 2: Initial Pulumi Setup

1. **Setup Pulumi Project**:
   - Initialize project structure
   - Configure Pulumi stacks for each environment
   - Set up state management

2. **Import Existing Resources**:
   - Use `pulumi import` to bring existing resources under management
   - Verify imported resources match actual configuration
   - Document any discrepancies

3. **Create Initial Infrastructure Code**:
   - Implement resource definitions based on imported state
   - Ensure no changes are applied during this phase
   - Validate code against existing infrastructure

### Phase 3: Incremental Migration

1. **Prioritize Resources**:
   - Start with less critical resources
   - Group resources by service or function
   - Create a migration schedule

2. **Migrate Resource Groups**:
   - Move one resource group at a time under Pulumi management
   - Validate each migration thoroughly
   - Roll back if issues are detected

3. **Update Deployment Processes**:
   - Integrate Pulumi deployments into CI/CD
   - Update documentation for new deployment flows
   - Train team members on new processes

### Phase 4: Complete Transition

1. **Finalize All Resources**:
   - Ensure all resources are managed by Pulumi
   - Remove any manual deployment steps
   - Validate complete infrastructure

2. **Implement Advanced Features**:
   - Set up drift detection
   - Implement policy as code
   - Enhance automation

3. **Document Final Architecture**:
   - Update all documentation
   - Create runbooks for common operations
   - Establish governance processes

## Implementation Plan

We will implement the Pulumi infrastructure in the following stages:

### Stage 1: Project Setup and Core Resources

1. Initialize Pulumi project structure
2. Implement D1 databases
3. Implement R2 buckets
4. Implement Vectorize indexes
5. Set up basic configuration

**Timeline**: 1 week

### Stage 2: Queue and Worker Implementation

1. Implement queue resources
2. Implement worker scripts
3. Configure worker bindings
4. Set up service bindings

**Timeline**: 2 weeks

### Stage 3: Environment Configuration

1. Configure dev environment
2. Configure staging environment
3. Configure production environment
4. Implement environment-specific settings

**Timeline**: 1 week

### Stage 4: Integration and Testing

1. Integrate with CI/CD
2. Implement validation tests
3. Create deployment workflows
4. Test full deployment process

**Timeline**: 1 week

### Stage 5: Migration and Cutover

1. Import existing resources
2. Validate imported state
3. Perform incremental cutover
4. Verify infrastructure integrity

**Timeline**: 2 weeks

## Best Practices

To ensure a successful implementation, we will follow these best practices:

### Code Organization

1. **Modular Structure**:
   - Separate resources by type
   - Use component resources for logical grouping
   - Create reusable modules

2. **Configuration Management**:
   - Use stack configuration files
   - Separate environment-specific settings
   - Implement variable validation

3. **Naming Conventions**:
   - Consistent resource naming
   - Clear stack naming
   - Descriptive variable names

### Deployment Workflow

1. **Preview Before Apply**:
   - Always run `pulumi preview` before applying changes
   - Review changes carefully
   - Get team approval for significant changes

2. **Incremental Changes**:
   - Make small, focused changes
   - Test each change thoroughly
   - Document change rationale

3. **Version Control**:
   - Commit infrastructure changes with application changes
   - Use feature branches
   - Implement pull request reviews

### Security

1. **Secret Management**:
   - Use Pulumi's secret management
   - Avoid hardcoded secrets
   - Rotate credentials regularly

2. **Least Privilege**:
   - Use minimal permissions for service accounts
   - Implement resource-level access controls
   - Audit access regularly

3. **Compliance**:
   - Document compliance requirements
   - Implement compliance checks
   - Maintain audit trails

## Security Considerations

When implementing infrastructure as code for Cloudflare resources, we need to address the following security considerations:

1. **API Token Management**:
   - Use scoped API tokens with minimal permissions
   - Rotate tokens regularly
   - Store tokens securely in Pulumi secrets

2. **Environment Isolation**:
   - Ensure strict separation between environments
   - Implement different access controls per environment
   - Use separate Pulumi stacks for each environment

3. **Secret Handling**:
   - Encrypt all sensitive values
   - Use Pulumi's secret management
   - Implement secret rotation

4. **Access Control**:
   - Implement RBAC for Pulumi access
   - Audit infrastructure access
   - Enforce approval workflows for production changes

5. **Compliance**:
   - Document regulatory requirements
   - Implement compliance checks
   - Maintain audit trails

## Monitoring and Maintenance

To ensure ongoing success with our infrastructure as code approach, we will implement the following monitoring and maintenance practices:

1. **Drift Detection**:
   - Regular infrastructure validation
   - Automated drift detection
   - Remediation processes

2. **Update Management**:
   - Regular provider updates
   - Dependency management
   - Compatibility testing

3. **Documentation**:
   - Keep documentation current
   - Document operational procedures
   - Maintain change logs

4. **Training**:
   - Onboard new team members
   - Regular skill updates
   - Knowledge sharing sessions

5. **Continuous Improvement**:
   - Regular architecture reviews
   - Performance optimization
   - Process refinement
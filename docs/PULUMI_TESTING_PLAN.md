# Pulumi Infrastructure Testing Plan

## Overview

This document outlines a comprehensive testing plan for the Dome project's Pulumi infrastructure implementation. The plan covers testing the deployment process across all environments (dev, staging, prod), validating resource creation, testing rollback procedures, and verifying the destroy process for the dev environment.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Testing Environment Setup](#testing-environment-setup)
- [Testing Phases](#testing-phases)
  - [Phase 1: Development Environment Testing](#phase-1-development-environment-testing)
  - [Phase 2: Staging Environment Testing](#phase-2-staging-environment-testing)
  - [Phase 3: Production Environment Testing](#phase-3-production-environment-testing)
  - [Phase 4: Cross-Environment Testing](#phase-4-cross-environment-testing)
- [Test Cases](#test-cases)
  - [Deployment Tests](#deployment-tests)
  - [Resource Validation Tests](#resource-validation-tests)
  - [Rollback Tests](#rollback-tests)
  - [Destroy Tests](#destroy-tests)
- [Test Execution Procedure](#test-execution-procedure)
- [Test Reporting](#test-reporting)
- [Troubleshooting Common Issues](#troubleshooting-common-issues)

## Prerequisites

Before executing the testing plan, ensure the following prerequisites are met:

1. **Pulumi CLI** is installed (version 3.0.0 or higher)
2. **Node.js** is installed (version 18.x or higher)
3. **pnpm** is installed
4. **Cloudflare API Token** with appropriate permissions is configured
5. **Environment variables** are properly set:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
6. **Pulumi login** has been performed
7. **Project dependencies** have been installed (`pnpm install` in the infra directory)

## Testing Environment Setup

### Isolated Testing Environment

1. Create a dedicated Pulumi organization for testing (if possible)
2. Set up separate Cloudflare resources for testing (if possible)
3. Configure environment-specific variables for testing

### Test Data

1. Prepare sample data for testing resource creation
2. Create test configurations for each environment
3. Prepare validation scripts to verify resource states

## Testing Phases

### Phase 1: Development Environment Testing

Focus on thorough testing of the development environment to establish baseline functionality.

#### Objectives:

- Verify all resources can be created successfully
- Validate resource configurations match expectations
- Test update scenarios for each resource type
- Verify resource dependencies are correctly managed
- Test rollback procedures
- Test destroy procedures

#### Success Criteria:

- All resources are created with correct configurations
- Updates are applied correctly
- Rollbacks restore the previous state accurately
- Resources can be destroyed without affecting non-managed resources

### Phase 2: Staging Environment Testing

Focus on testing the staging environment with configurations closer to production.

#### Objectives:

- Verify all resources can be created in the staging environment
- Validate staging-specific configurations
- Test the promotion process from dev to staging
- Verify service bindings and dependencies work correctly
- Test partial updates and their impact

#### Success Criteria:

- All resources are created with correct staging configurations
- Promotion from dev to staging works as expected
- Service bindings function correctly
- Partial updates apply correctly without breaking dependencies

### Phase 3: Production Environment Testing

Focus on testing the production environment with strict validation and safety measures.

#### Objectives:

- Verify production deployment safeguards
- Validate production-specific configurations
- Test the promotion process from staging to production
- Verify all resources function correctly in production
- Test rollback procedures with production safeguards

#### Success Criteria:

- Production safeguards prevent unauthorized or dangerous operations
- All resources are created with correct production configurations
- Promotion from staging to production works as expected
- Rollback procedures work correctly with production safeguards

### Phase 4: Cross-Environment Testing

Focus on testing interactions and transitions between environments.

#### Objectives:

- Test the complete promotion flow from dev to staging to production
- Verify environment isolation
- Test resource naming consistency across environments
- Validate environment-specific configurations are applied correctly

#### Success Criteria:

- Complete promotion flow works as expected
- Environments remain isolated
- Resource naming is consistent across environments
- Environment-specific configurations are applied correctly

## Test Cases

### Deployment Tests

#### Test Case D1: Initial Deployment

- **Objective**: Verify initial deployment creates all resources correctly
- **Steps**:
  1. Run `just pulumi-up dev` to deploy the dev environment
  2. Verify all resources are created
  3. Validate resource configurations
- **Expected Result**: All resources are created with correct configurations

#### Test Case D2: Incremental Deployment

- **Objective**: Verify changes to existing resources are applied correctly
- **Steps**:
  1. Modify a resource configuration
  2. Run `just pulumi-up dev` to apply the changes
  3. Verify the changes are applied correctly
- **Expected Result**: Changes are applied correctly without affecting other resources

#### Test Case D3: Environment-Specific Deployment

- **Objective**: Verify environment-specific configurations are applied correctly
- **Steps**:
  1. Deploy to each environment (dev, staging, prod)
  2. Verify environment-specific configurations are applied
- **Expected Result**: Each environment has the correct configurations

#### Test Case D4: Dependency Management

- **Objective**: Verify resource dependencies are managed correctly
- **Steps**:
  1. Create a new resource that depends on an existing resource
  2. Deploy the changes
  3. Verify the dependency is resolved correctly
- **Expected Result**: Dependencies are resolved correctly during deployment

### Resource Validation Tests

#### Test Case R1: D1 Database Validation

- **Objective**: Verify D1 databases are created correctly
- **Steps**:
  1. Deploy the infrastructure
  2. Verify D1 databases exist in Cloudflare
  3. Validate database configurations
- **Expected Result**: D1 databases exist with correct configurations

#### Test Case R2: R2 Bucket Validation

- **Objective**: Verify R2 buckets are created correctly
- **Steps**:
  1. Deploy the infrastructure
  2. Verify R2 buckets exist in Cloudflare
  3. Validate bucket configurations
- **Expected Result**: R2 buckets exist with correct configurations

#### Test Case R3: Worker Validation

- **Objective**: Verify workers are created correctly
- **Steps**:
  1. Deploy the infrastructure
  2. Verify workers exist in Cloudflare
  3. Validate worker configurations, bindings, and environment variables
- **Expected Result**: Workers exist with correct configurations

#### Test Case R4: Queue Validation

- **Objective**: Verify queues are created correctly
- **Steps**:
  1. Deploy the infrastructure
  2. Verify queues exist in Cloudflare
  3. Validate queue configurations
- **Expected Result**: Queues exist with correct configurations

#### Test Case R5: Service Binding Validation

- **Objective**: Verify service bindings are created correctly
- **Steps**:
  1. Deploy the infrastructure
  2. Verify service bindings exist in Cloudflare
  3. Validate binding configurations
- **Expected Result**: Service bindings exist with correct configurations

### Rollback Tests

#### Test Case RB1: Simple Rollback

- **Objective**: Verify rollback to a previous state works correctly
- **Steps**:
  1. Deploy the infrastructure
  2. Make a change and deploy again
  3. Run `pulumi stack select dev && pulumi update --target-version 1` to rollback
  4. Verify the state is restored to the previous version
- **Expected Result**: State is restored to the previous version

#### Test Case RB2: Dependency-Aware Rollback

- **Objective**: Verify rollback handles dependencies correctly
- **Steps**:
  1. Deploy the infrastructure with interdependent resources
  2. Make changes to multiple resources and deploy
  3. Rollback to the previous state
  4. Verify all dependencies are maintained correctly
- **Expected Result**: All resources and dependencies are restored correctly

#### Test Case RB3: Failed Deployment Rollback

- **Objective**: Verify automatic rollback on failed deployment
- **Steps**:
  1. Introduce an error in the infrastructure code
  2. Attempt to deploy
  3. Verify the deployment fails and rolls back automatically
- **Expected Result**: Failed deployment triggers automatic rollback

### Destroy Tests

#### Test Case DS1: Dev Environment Destroy

- **Objective**: Verify destroy process for dev environment
- **Steps**:
  1. Deploy the dev environment
  2. Run `just pulumi-destroy dev` to destroy the environment
  3. Verify all resources are removed
- **Expected Result**: All resources are removed correctly

#### Test Case DS2: Partial Destroy

- **Objective**: Verify partial destroy process
- **Steps**:
  1. Deploy the infrastructure
  2. Run `pulumi destroy --target <resource-name>` to destroy a specific resource
  3. Verify the resource is removed without affecting dependencies
- **Expected Result**: Specified resource is removed correctly

#### Test Case DS3: Production Safeguards

- **Objective**: Verify production destroy safeguards
- **Steps**:
  1. Attempt to run `just pulumi-destroy prod`
  2. Verify the operation is blocked
- **Expected Result**: Production destroy operation is blocked

## Test Execution Procedure

### Pre-Execution Checklist

1. Verify all prerequisites are met
2. Ensure the testing environment is properly set up
3. Backup any existing state files
4. Clear any previous test data

### Execution Steps

1. Execute tests in the order specified by the testing phases
2. Document all test results
3. Address any failures before proceeding to the next test
4. Maintain a clean state between tests

### Post-Execution Cleanup

1. Destroy all test resources
2. Clean up any test data
3. Restore any backed-up state files

## Test Reporting

### Test Report Template

For each test case, record the following information:

- Test case ID and name
- Test date and time
- Test environment
- Test executor
- Test result (Pass/Fail)
- Observations
- Issues encountered
- Screenshots or logs
- Recommendations

### Reporting Process

1. Generate a test report for each test case
2. Compile a summary report for each testing phase
3. Create a final test report with all results and recommendations

## Troubleshooting Common Issues

### Deployment Failures

#### Issue: Resource Creation Failure

- **Symptoms**: Pulumi reports resource creation failure
- **Possible Causes**:
  - Invalid resource configuration
  - API token permissions
  - Resource name conflicts
  - Resource limits reached
- **Resolution Steps**:
  1. Check the error message for specific details
  2. Verify resource configuration
  3. Check API token permissions
  4. Verify resource name uniqueness
  5. Check resource limits

#### Issue: Dependency Resolution Failure

- **Symptoms**: Pulumi reports dependency resolution failure
- **Possible Causes**:
  - Circular dependencies
  - Missing dependencies
  - Incorrect dependency order
- **Resolution Steps**:
  1. Check the dependency graph
  2. Verify all dependencies exist
  3. Correct the dependency order

#### Issue: State File Corruption

- **Symptoms**: Pulumi reports state file corruption or inconsistency
- **Possible Causes**:
  - Manual changes to resources
  - Interrupted deployment
  - Concurrent deployments
- **Resolution Steps**:
  1. Run `pulumi refresh` to update the state
  2. Manually fix any inconsistencies
  3. Consider importing resources if necessary

### Environment-Specific Issues

#### Issue: Environment Configuration Mismatch

- **Symptoms**: Resources are created with incorrect configurations
- **Possible Causes**:
  - Incorrect stack selection
  - Missing environment-specific configuration
  - Configuration override issues
- **Resolution Steps**:
  1. Verify the correct stack is selected
  2. Check environment-specific configuration
  3. Verify configuration precedence

#### Issue: Cross-Environment Resource Conflicts

- **Symptoms**: Resource creation fails due to conflicts
- **Possible Causes**:
  - Resource name conflicts across environments
  - Shared resources between environments
- **Resolution Steps**:
  1. Use environment-specific resource naming
  2. Isolate resources between environments
  3. Use resource namespacing

### Rollback Issues

#### Issue: Failed Rollback

- **Symptoms**: Rollback operation fails
- **Possible Causes**:
  - Dependent resources cannot be rolled back
  - External changes to resources
  - State file inconsistencies
- **Resolution Steps**:
  1. Identify the specific resources causing the failure
  2. Manually adjust resources if necessary
  3. Consider a fresh deployment if rollback is not possible

#### Issue: Incomplete Rollback

- **Symptoms**: Rollback completes but some resources remain in the new state
- **Possible Causes**:
  - Resources not managed by Pulumi
  - Resource protection settings
  - Dependency issues
- **Resolution Steps**:
  1. Identify resources not rolled back
  2. Check resource protection settings
  3. Manually adjust resources if necessary

### Destroy Issues

#### Issue: Failed Destroy

- **Symptoms**: Destroy operation fails
- **Possible Causes**:
  - Resource dependencies
  - Resource protection settings
  - External dependencies
- **Resolution Steps**:
  1. Identify the specific resources causing the failure
  2. Check for dependencies and remove them first
  3. Check resource protection settings
  4. Consider manual resource removal if necessary

#### Issue: Orphaned Resources

- **Symptoms**: Resources remain after destroy operation
- **Possible Causes**:
  - Resources not managed by Pulumi
  - Failed destroy operations
  - Resource protection settings
- **Resolution Steps**:
  1. Identify orphaned resources
  2. Import resources into Pulumi if necessary
  3. Manually remove resources if necessary

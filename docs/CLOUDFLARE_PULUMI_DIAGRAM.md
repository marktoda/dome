# Cloudflare Infrastructure Diagram

This document provides visual diagrams of the Cloudflare infrastructure that will be managed by Pulumi.

## Overall Architecture

```mermaid
graph TD
    subgraph "Pulumi Infrastructure as Code"
        Pulumi[Pulumi Project]
        PulumiState[Pulumi State]
        PulumiConfig[Configuration]
    end

    subgraph "Cloudflare Resources"
        subgraph "Workers"
            DomeAPI[dome-api]
            Silo[silo]
            Constellation[constellation]
            AIProcessor[ai-processor]
            DomeCron[dome-cron]
            DomeNotify[dome-notify]
        end

        subgraph "Storage"
            D1DB1[D1: dome-meta]
            D1DB2[D1: silo]
            R2B1[R2: dome-raw]
            R2B2[R2: silo-content]
            VectorizeIndex[Vectorize: dome-notes]
        end

        subgraph "Messaging"
            Q1[Queue: new-content-constellation]
            Q2[Queue: new-content-ai]
            Q3[Queue: content-events]
            Q4[Queue: enriched-content]
            Q5[Queue: dome-events]
            Q6[Queue: embed-dead-letter]
        end

        subgraph "Bindings"
            AI[Workers AI]
            ServiceBindings[Service Bindings]
        end

        subgraph "Triggers"
            CronTrigger[Cron Trigger]
        end
    end

    Pulumi -->|Manages| DomeAPI
    Pulumi -->|Manages| Silo
    Pulumi -->|Manages| Constellation
    Pulumi -->|Manages| AIProcessor
    Pulumi -->|Manages| DomeCron
    Pulumi -->|Manages| DomeNotify

    Pulumi -->|Manages| D1DB1
    Pulumi -->|Manages| D1DB2
    Pulumi -->|Manages| R2B1
    Pulumi -->|Manages| R2B2
    Pulumi -->|Manages| VectorizeIndex

    Pulumi -->|Manages| Q1
    Pulumi -->|Manages| Q2
    Pulumi -->|Manages| Q3
    Pulumi -->|Manages| Q4
    Pulumi -->|Manages| Q5
    Pulumi -->|Manages| Q6

    Pulumi -->|Manages| AI
    Pulumi -->|Manages| ServiceBindings
    Pulumi -->|Manages| CronTrigger

    PulumiConfig -->|Configures| Pulumi
    Pulumi -->|Updates| PulumiState
```

## Service Relationships

```mermaid
graph TD
    Client[Client Applications] -->|API Requests| DomeAPI[dome-api]

    DomeAPI -->|Service Binding| Constellation[constellation]
    DomeAPI -->|Service Binding| Silo[silo]

    Constellation -->|Service Binding| Silo
    Constellation -->|Uses| VectorizeIndex[Vectorize: dome-notes]
    Constellation -->|Uses| AI[Workers AI]
    Constellation -->|Consumes| Q1[Queue: new-content-constellation]
    Constellation -->|Produces| Q6[Queue: embed-dead-letter]

    Silo -->|Uses| D1DB2[D1: silo]
    Silo -->|Uses| R2B2[R2: silo-content]
    Silo -->|Produces| Q1[Queue: new-content-constellation]
    Silo -->|Produces| Q2[Queue: new-content-ai]
    Silo -->|Consumes| Q3[Queue: content-events]
    Silo -->|Consumes| Q4[Queue: enriched-content]

    AIProcessor[ai-processor] -->|Service Binding| Silo
    AIProcessor -->|Uses| AI
    AIProcessor -->|Consumes| Q2
    AIProcessor -->|Produces| Q4

    DomeCron[dome-cron] -->|Uses| D1DB1[D1: dome-meta]
    DomeCron -->|Produces| Q5[Queue: dome-events]
    CronTrigger[Cron Trigger] -->|Triggers| DomeCron

    DomeNotify[dome-notify] -->|Consumes| Q5
```

## Pulumi Project Structure

```mermaid
graph TD
    subgraph "infra/"
        index.ts[index.ts]
        package.json[package.json]
        tsconfig.json[tsconfig.json]
        PulumiYaml[Pulumi.yaml]
        PulumiDevYaml[Pulumi.dev.yaml]
        PulumiStagingYaml[Pulumi.staging.yaml]
        PulumiProdYaml[Pulumi.prod.yaml]

        subgraph "src/"
            config.ts[config.ts]

            subgraph "resources/"
                workers.ts[workers.ts]
                databases.ts[databases.ts]
                storage.ts[storage.ts]
                vectorize.ts[vectorize.ts]
                queues.ts[queues.ts]
                bindings.ts[bindings.ts]
            end

            subgraph "stacks/"
                dev.ts[dev.ts]
                staging.ts[staging.ts]
                prod.ts[prod.ts]
            end

            subgraph "utils/"
                naming.ts[naming.ts]
                tags.ts[tags.ts]
            end
        end

        subgraph "scripts/"
            import.ts[import-existing.ts]
            validate.ts[validate.ts]
        end
    end

    index.ts -->|Imports| dev.ts
    index.ts -->|Imports| staging.ts
    index.ts -->|Imports| prod.ts
    index.ts -->|Imports| config.ts

    dev.ts -->|Uses| workers.ts
    dev.ts -->|Uses| databases.ts
    dev.ts -->|Uses| storage.ts
    dev.ts -->|Uses| vectorize.ts
    dev.ts -->|Uses| queues.ts
    dev.ts -->|Uses| bindings.ts

    staging.ts -->|Uses| workers.ts
    staging.ts -->|Uses| databases.ts
    staging.ts -->|Uses| storage.ts
    staging.ts -->|Uses| vectorize.ts
    staging.ts -->|Uses| queues.ts
    staging.ts -->|Uses| bindings.ts

    prod.ts -->|Uses| workers.ts
    prod.ts -->|Uses| databases.ts
    prod.ts -->|Uses| storage.ts
    prod.ts -->|Uses| vectorize.ts
    prod.ts -->|Uses| queues.ts
    prod.ts -->|Uses| bindings.ts

    workers.ts -->|Uses| config.ts
    databases.ts -->|Uses| config.ts
    storage.ts -->|Uses| config.ts
    vectorize.ts -->|Uses| config.ts
    queues.ts -->|Uses| config.ts
    bindings.ts -->|Uses| config.ts

    config.ts -->|Uses| naming.ts
    config.ts -->|Uses| tags.ts
```

## Migration Process

```mermaid
flowchart TD
    Start[Start Migration] --> Inventory[Inventory Existing Resources]
    Inventory --> Setup[Setup Pulumi Project]
    Setup --> Import[Import Existing Resources]
    Import --> Validate[Validate Imported State]
    Validate --> Prioritize[Prioritize Resource Groups]

    Prioritize --> MigrateDB[Migrate D1 Databases]
    MigrateDB --> ValidateDB{Validate}
    ValidateDB -->|Success| MigrateR2[Migrate R2 Buckets]
    ValidateDB -->|Failure| FixDB[Fix Issues]
    FixDB --> MigrateDB

    MigrateR2 --> ValidateR2{Validate}
    ValidateR2 -->|Success| MigrateVectorize[Migrate Vectorize Indexes]
    ValidateR2 -->|Failure| FixR2[Fix Issues]
    FixR2 --> MigrateR2

    MigrateVectorize --> ValidateVectorize{Validate}
    ValidateVectorize -->|Success| MigrateQueues[Migrate Queues]
    ValidateVectorize -->|Failure| FixVectorize[Fix Issues]
    FixVectorize --> MigrateVectorize

    MigrateQueues --> ValidateQueues{Validate}
    ValidateQueues -->|Success| MigrateWorkers[Migrate Workers]
    ValidateQueues -->|Failure| FixQueues[Fix Issues]
    FixQueues --> MigrateQueues

    MigrateWorkers --> ValidateWorkers{Validate}
    ValidateWorkers -->|Success| MigrateBindings[Migrate Service Bindings]
    ValidateWorkers -->|Failure| FixWorkers[Fix Issues]
    FixWorkers --> MigrateWorkers

    MigrateBindings --> ValidateBindings{Validate}
    ValidateBindings -->|Success| IntegrateCI[Integrate with CI/CD]
    ValidateBindings -->|Failure| FixBindings[Fix Issues]
    FixBindings --> MigrateBindings

    IntegrateCI --> ValidateCI{Validate}
    ValidateCI -->|Success| Complete[Migration Complete]
    ValidateCI -->|Failure| FixCI[Fix Issues]
    FixCI --> IntegrateCI
```

## Deployment Workflow

```mermaid
flowchart TD
    Start[Developer Makes Changes] --> Commit[Commit to Git]
    Commit --> PR[Create Pull Request]
    PR --> CI[CI Runs Pulumi Preview]
    CI --> Review[Team Reviews Changes]
    Review --> Approve{Approved?}
    Approve -->|Yes| Merge[Merge to Main]
    Approve -->|No| Revise[Revise Changes]
    Revise --> Commit

    Merge --> CD[CD Pipeline Triggered]
    CD --> DeployDev[Deploy to Dev]
    DeployDev --> ValidateDev{Validate Dev}
    ValidateDev -->|Success| DeployStaging[Deploy to Staging]
    ValidateDev -->|Failure| Rollback[Rollback Changes]
    Rollback --> Revise

    DeployStaging --> ValidateStaging{Validate Staging}
    ValidateStaging -->|Success| ApproveProduction{Approve Production?}
    ValidateStaging -->|Failure| Rollback

    ApproveProduction -->|Yes| DeployProduction[Deploy to Production]
    ApproveProduction -->|No| Revise

    DeployProduction --> ValidateProduction{Validate Production}
    ValidateProduction -->|Success| Complete[Deployment Complete]
    ValidateProduction -->|Failure| RollbackProduction[Rollback Production]
    RollbackProduction --> Revise
```

These diagrams provide a visual representation of the Cloudflare infrastructure, the Pulumi project structure, the migration process, and the deployment workflow. They can be used to better understand the relationships between different components and the overall architecture of the system.

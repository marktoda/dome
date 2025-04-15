# Communicator Cloudflare Documentation

Welcome to the documentation for the Communicator Cloudflare project. This documentation provides comprehensive information about the project's architecture, implementation details, and development workflows.

## Table of Contents

1. [Architecture](./architecture.md)
2. [Hono Framework Integration](./hono-integration.md)
3. [Justfile Commands](./justfile-commands.md)

## Overview

The Communicator Cloudflare project is designed to ingest messages from various platforms (Telegram, Twitter, Slack, etc.), process them through an LLM pipeline to categorize, prioritize, summarize, and generate responses based on user feedback. The system is built as a microservices monorepo using Cloudflare Workers, with infrastructure managed by Pulumi.

The project supports two methods of message ingestion:
1. **Pull-based ingestion**: The ingestor service periodically polls external APIs to fetch new messages
2. **Push-based ingestion**: The push-message-ingestor service provides endpoints that external systems can push messages to directly

## Key Features

- Message ingestion from multiple platforms (both pull and push-based)
- Support for various messaging platforms (Telegram, with extensibility for others)
- Conversation grouping and analysis
- LLM-based processing for categorization and prioritization
- Response generation and delivery
- Multi-user support
- Reproducible infrastructure configuration
- Local development and testing capabilities

## Documentation Structure

### [Architecture](./architecture.md)

The architecture document provides a comprehensive overview of the system's design, including:

- System architecture diagram
- Component descriptions
- Data flow between services
- Directory structure
- Infrastructure requirements
- Development workflow
- Deployment strategy
- Testing approach
- Scaling considerations

### [Hono Framework Integration](./hono-integration.md)

The Hono integration document provides detailed information about the integration of the Hono framework in the project, including:

- Benefits of using Hono
- Implementation details
- Worker structure
- Middleware
- Type safety
- Environment variables
- Error handling
- Creating new services
- Migrating existing services
- Best practices

### [Justfile Commands](./justfile-commands.md)

The justfile commands document provides detailed information about the commands available in the justfile, including:

- Basic commands
- Development commands
- Build commands
- Service creation commands
- Infrastructure commands
- Database commands
- Deployment commands
- Utility commands

## Getting Started

To get started with the project, follow these steps:

1. Clone the repository
2. Install dependencies:
   ```bash
   just install
   ```
3. Run the ingestor service locally:
   ```bash
   just dev ingestor
   ```

For more detailed instructions, refer to the [architecture document](./architecture.md) and the [justfile commands document](./justfile-commands.md).

## Contributing

When contributing to the project, please follow these guidelines:

1. Use the appropriate service creation commands to create new services:
   ```bash
   just new-hono-service my-service-name
   ```
   or
   ```bash
   just new-rust-service my-rust-service
   ```

2. Follow the project's coding standards and best practices as outlined in the documentation.

3. Write tests for your code and ensure all tests pass before submitting a pull request.

4. Update the documentation as needed to reflect any changes or additions to the project.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
# Claude AI Assistant Configuration

This document provides configuration guidelines specifically for Claude AI assistants working with the Dome repository.

## Primary Configuration

For comprehensive guidelines, coding standards, workflows, and best practices, please refer to **`AGENTS.md`** - the master configuration file that contains all AI assistant rules and repository guidelines.

## Claude-Specific Guidelines

### Code Style and Preferences
- Prioritize code readability and maintainability
- Follow the repository's established patterns and conventions
- Use TypeScript consistently across all services
- Leverage the Hono framework for web applications and APIs
- Implement proper error handling using patterns from `@dome/common`

### Communication Style
- Be concise and direct in code comments and documentation
- Focus on explaining the "why" rather than the "what" in complex logic
- Use clear, descriptive variable and function names
- Follow conventional commit message format for all commits

### Repository Navigation
- Always verify current directory with `pwd` before executing commands
- Use the justfile commands for standardized workflows (`just build`, `just test`, etc.)
- Navigate to specific service directories before running service-specific commands
- Understand the monorepo structure and service relationships

### Development Workflow
1. Install dependencies: `pnpm install`
2. Build and test before making changes: `just build` && `just test`
3. Make focused, incremental changes
4. Run quality gates before committing:
   - `just build` - must pass
   - `just lint` - must pass without errors
   - `just test` - all tests must pass
5. Follow conventional commits for commit messages
6. Create focused pull requests with clear descriptions

### Inter-Service Communication
- Prefer Cloudflare Worker RPC bindings over HTTP fetch
- Use established service clients when available
- Follow the repository's service communication patterns
- Maintain type safety across service boundaries

### Quality Standards
- All code must be properly typed with TypeScript
- Include tests for new functionality
- Use Zod for runtime validation and type safety
- Follow the established error handling patterns
- Ensure code passes all linting and type checking

### Security Considerations
- Never commit credentials or secrets
- Use environment variables for configuration
- Follow least privilege principle
- Use proper authentication and authorization patterns

## Quick Commands Reference

- `just build` - Build all services
- `just test` - Run all tests
- `just lint` - Check code style
- `just build-pkg <name>` - Build specific service
- `just test-pkg <name>` - Test specific service
- `wrangler dev` - Local development
- `wrangler deploy` - Deploy worker

## For Complete Guidelines

Always consult **`AGENTS.md`** for the full set of guidelines, best practices, and detailed workflow instructions.
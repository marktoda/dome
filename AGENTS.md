# Dome AGENTS Onboarding Guide

This document provides key information for LLMs contributing to the Dome repository. Use it as a quick reference for typical workflows and best practices. For full details see `.roo/rules/01-general.md` or `.cursorrules`.

## Repository Overview

- **Monorepo layout** with microservices under `services/` and shared code in `packages/`.
- Infrastructure code lives in `infra/` and Cloudflare worker templates are in `templates/`.
- Tests reside next to each service or package.

## Workflow Basics

1. Install dependencies with `pnpm install`.
2. Build and test using just commands:
   - `just build` – compile all packages.
   - `just build-pkg <pkg>` – build a single package or service.
   - `just test` – run vitest across the repo.
   - `just test-pkg <pkg>` – run tests for one package.
   - `just lint` – check code style (`just lint-fix` to auto-fix).
   - `just lint-pkg <pkg>` – lint only a single package.
3. Use `wrangler` for Cloudflare Workers operations (`wrangler dev`, `wrangler deploy`).
4. When creating new services, use templates in `templates/` and add them to the pnpm workspace.

## Coding Guidelines

- Keep the code simple, readable and well-typed.
- Prefer RPC bindings over HTTP fetches for inter-service calls.
- Follow the established error handling and logging patterns from `@dome/common`.
- Use the Hono framework for APIs and zValidator/Zod for validation.
- Add tests for new features and run them before committing.
- Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/).

## Pull Requests

- Branch from `main` and keep changes focused on a single concern.
- Ensure `just build`, `just lint`, and `just test` all succeed before opening a PR.
- Update documentation when behavior or APIs change.

## Security

- Never commit credentials or other secrets.
- Configure sensitive data via environment variables or `.dev.vars` files.

For further information consult the documentation in the `docs/` directory.

# Build Process Documentation

This document explains the build system for Dome and why each step is necessary.

## Overview

Dome uses a two-stage build process:
1. **TypeScript Compilation** (`tsc`) - Compiles the CLI application
2. **Mastra Build** (`mastra build`) - Processes AI framework components

## Build Commands

### Development
```bash
npm run dev          # Runs Mastra development server with hot reload
npm run cli:dev      # Runs the CLI directly with tsx (TypeScript runtime)
```

### Production Build
```bash
npm run build        # Full production build (clean + tsc + mastra)
```

This runs three steps in sequence:
1. `npm run clean` - Removes the `dist/` directory
2. `npm run cli:build` - Runs TypeScript compiler (`tsc`)
3. `mastra build` - Runs Mastra framework build

### Individual Build Steps
```bash
npm run cli:build    # Only TypeScript compilation
npm run mastra:build # Only Mastra framework build
```

## Why Two Build Steps?

### TypeScript Compilation (`tsc`)
- **Purpose**: Converts TypeScript source code to JavaScript
- **Input**: `src/**/*.ts` files
- **Output**: `dist/` directory with JavaScript files
- **Config**: Uses `tsconfig.json` with ES2022 modules and "bundler" resolution
- **Required for**: The CLI executable and all TypeScript code

### Mastra Build (`mastra build`)
- **Purpose**: Processes Mastra-specific AI components
- **Input**: Mastra agents, workflows, and tools in `src/mastra/`
- **Output**: Optimized Mastra runtime artifacts
- **Required for**: AI agent functionality, workflow execution, and tool integration

## Module System

The project uses ES modules throughout:
- `package.json` has `"type": "module"`
- `tsconfig.json` targets ES2022 modules
- All imports use ES module syntax

## Build Dependencies

- **rimraf**: Cross-platform directory removal for clean builds
- **typescript**: TypeScript compiler
- **mastra**: AI framework with its own build pipeline
- **tsx**: TypeScript runtime for development (bypasses build)

## CI/CD

The GitHub Actions workflow (`ci.yml`) runs:
1. `npm ci` - Install dependencies
2. `npm run build` - Full production build
3. `npm test` - Run test suite

## Troubleshooting

### Common Issues

1. **"Cannot find module" errors**
   - Ensure you've run `npm run build` after pulling changes
   - Check that both build steps completed successfully

2. **Mastra-related errors**
   - Verify Mastra CLI is installed: `npm ls mastra`
   - Check Mastra agents/workflows syntax in `src/mastra/`

3. **Module resolution errors**
   - Ensure Node.js version >= 20.9.0 (ES modules support)
   - Check file extensions in imports (`.js` for ES modules)

### Build Performance

To speed up builds during development:
- Use `npm run cli:dev` to skip compilation
- Run only `npm run cli:build` if not changing Mastra components
- Use `npm run dev` for hot-reload during Mastra development
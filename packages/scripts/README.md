# Dome Scripts

This package contains utility scripts for the Dome project.

## Available Scripts

### ingest-norg

This script finds all `.norg` files in the `~/neorg` directory and ingests them into the system using the `just cli add` command.

#### Usage

First, build the package:

```bash
# From the root of the repository
pnpm --filter @dome/scripts build
```

Then run the script:

```bash
# From the root of the repository
pnpm --filter @dome/scripts ingest-norg
```

Or using the `just` command:

```bash
just scripts-ingest-norg
```

#### Features

- Recursively finds all `.norg` files in the `~/neorg` directory
- Processes files one by one with a small delay between each to avoid overwhelming the system
- Provides clear console output with color-coded status messages
- Handles errors gracefully, continuing to process remaining files if one fails

#### Environment Variables

- `DEBUG`: Set to any value to enable verbose output logging

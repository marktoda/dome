# File Filtering in Tsunami

## Overview

Tsunami's file filtering feature allows you to exclude specific files and directories from being ingested into the system. This is particularly useful for:

- Reducing noise from build artifacts, dependencies, and generated files
- Decreasing ingestion time and storage usage
- Focusing on relevant source code files
- Improving search and analysis quality

The filtering system uses a `.tsunamiignore` file that follows a syntax similar to `.gitignore`, making it familiar and easy to use.

## Creating a `.tsunamiignore` File

To use the file filtering feature, create a file named `.tsunamiignore` in the root directory of your repository. This file should contain patterns that match files and directories you want to exclude from ingestion.

Example `.tsunamiignore` file:

```
# Build artifacts
dist/
build/
node_modules/

# Generated files
*.min.js
*.bundle.js

# Large data files
*.csv
*.sqlite
```

## Ignore Pattern Syntax

The `.tsunamiignore` file uses a syntax similar to `.gitignore` files:

### Basic Patterns

- Blank lines are ignored
- Lines starting with `#` are treated as comments
- Patterns match file and directory names relative to the repository root
- Patterns ending with a slash (`/`) match directories only
- Patterns not ending with a slash match both files and directories

### Wildcards

- `*` matches any sequence of characters except `/`
- `**` matches any sequence of characters including `/` (matches across directories)
- `?` matches any single character except `/`

### Negation

- Patterns starting with `!` negate the pattern (include files that would otherwise be excluded)
- If a file matches both an exclude pattern and a negated pattern, the negated pattern takes precedence (the file will be included)

## Examples

### Common Patterns to Ignore

#### Build Artifacts and Dependencies

```
# Node.js
node_modules/
dist/
build/
.next/

# Python
__pycache__/
*.py[cod]
*.so
.Python
env/
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
*.egg-info/
.installed.cfg
*.egg

# Rust
target/

# Java/Maven
target/
*.class
*.jar

# .NET
bin/
obj/
```

#### Generated Files

```
# Minified and bundled files
*.min.js
*.min.css
*.bundle.js
*.generated.*

# Documentation
docs/_build/
site/

# Coverage reports
coverage/
.nyc_output/
```

#### Binary and Media Files

```
# Images
*.jpg
*.jpeg
*.png
*.gif
*.ico
*.svg

# Fonts
*.woff
*.woff2
*.ttf
*.eot

# Audio/Video
*.mp3
*.mp4
*.mov

# Documents
*.pdf

# Archives
*.zip
*.tar
*.gz
```

#### IDE and Editor Files

```
# IDE directories
.idea/
.vscode/

# OS files
.DS_Store
Thumbs.db
```

#### Large Data Files

```
# Data files
*.csv
*.tsv
*.sqlite
*.db
```

### Advanced Examples

#### Ignoring All Files Except Specific Types

```
# Ignore everything
*

# But include these file types
!*.js
!*.ts
!*.jsx
!*.tsx
!*.md
!*.html
!*.css
```

#### Ignoring Files in Specific Directories But Not Others

```
# Ignore all JSON files
*.json

# Except those in the config directory
!config/*.json
```

#### Ignoring Specific Files in All Directories

```
# Ignore package-lock.json in all directories
**/package-lock.json
```

## Default Ignore Patterns

If no `.tsunamiignore` file is found in your repository, Tsunami will apply the following default patterns:

```
# Build artifacts and dependencies
node_modules/**
dist/**
build/**
.next/**
vendor/**
target/**
bin/**
obj/**

# Package manager files
package-lock.json
yarn.lock
pnpm-lock.yaml
Cargo.lock

# Generated files
*.min.js
*.min.css
*.bundle.js
*.generated.*

# Binary and media files
*.jpg
*.jpeg
*.png
*.gif
*.ico
*.svg
*.woff
*.woff2
*.ttf
*.eot
*.mp3
*.mp4
*.mov
*.pdf
*.zip
*.tar
*.gz
*.jar
*.exe
*.dll
*.so
*.dylib

# Cache and temporary files
.cache/**
.tmp/**
tmp/**
temp/**
*.log

# IDE and editor files
.idea/**
.vscode/**
.DS_Store
Thumbs.db

# Test coverage and reports
coverage/**
.nyc_output/**
junit.xml

# Large data files
*.csv
*.tsv
*.sqlite
*.db
```

These default patterns are designed to exclude common non-source code files while preserving important source files for analysis.

## Overriding Default Patterns

There are two ways to override the default ignore patterns:

### 1. Create a Custom `.tsunamiignore` File

Simply creating a `.tsunamiignore` file in your repository will override the default patterns. Your custom patterns will be used instead of the defaults.

### 2. Include Files That Would Be Excluded by Default

If you want to include specific files that would be excluded by the default patterns, you can create a `.tsunamiignore` file with negation patterns:

```
# Use default patterns but include specific files
!dist/important-file.js
!*.min.js
```

Note that this approach only works if you're starting with the default patterns and then selectively overriding them. If you create a `.tsunamiignore` file with your own patterns, the default patterns won't be applied at all.

## Configuration Options

The file filtering system has several configuration options that can be adjusted by system administrators:

- `enabled`: Whether file filtering is enabled (default: `true`)
- `useDefaultPatternsWhenNoIgnoreFile`: Whether to use default patterns when no `.tsunamiignore` file is found (default: `true`)
- `ignoreFileName`: The name of the ignore file to look for in repositories (default: `.tsunamiignore`)
- `logFilteredFiles`: Whether to log detailed information about filtered files (default: `true`)
- `trackFilterMetrics`: Whether to track metrics about filtered files (default: `true`)

## Best Practices

1. **Start with a template**: Use the default patterns as a starting point and customize for your project.
2. **Be specific**: Use specific patterns to avoid accidentally excluding important files.
3. **Test your patterns**: Verify that your patterns exclude only the files you intend to exclude.
4. **Document your choices**: Add comments to your `.tsunamiignore` file to explain why certain patterns are included.
5. **Review periodically**: As your project evolves, review and update your `.tsunamiignore` file to ensure it still meets your needs.

## Troubleshooting

If files are being unexpectedly included or excluded during ingestion:

1. Check your `.tsunamiignore` file for syntax errors or conflicting patterns.
2. Remember that negation patterns (`!`) take precedence over exclusion patterns.
3. Verify that your patterns match the file paths correctly (remember paths are relative to the repository root).
4. If you're using wildcards, ensure they're matching as expected.
5. For directory-specific patterns, make sure you're using the trailing slash (`/`) correctly.

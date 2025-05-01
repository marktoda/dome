#!/bin/bash

# Copy the development environment file
cp .env.local.dev .env.local

# Build the application
npm run pages:build

# Start the development server
npm run pages:dev
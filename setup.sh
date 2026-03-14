#!/bin/bash
set -e

# Install dependencies and build SAGE CLI
npm install
npm run build

echo "Build complete. Run: node dist/index.js"

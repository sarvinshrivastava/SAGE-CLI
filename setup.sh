#!/bin/bash
set -e

# Install bun if not present
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Install dependencies and build SAGE CLI
bun install
bun run build

echo "Build complete. Run: bun dist/index.js"

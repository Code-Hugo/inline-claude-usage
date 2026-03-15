#!/bin/bash
# inline-claude-usage installer
# Sets up the statusLine in Claude Code and runs the interactive setup wizard.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

echo ""
echo "inline-claude-usage — installer"
echo "================================"
echo ""

# 1. Ensure node is available
if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Please install it from https://nodejs.org and re-run."
  exit 1
fi
echo "✓ Node.js $(node --version) found"

# 2. Ensure ~/.claude/settings.json exists
if [ ! -f "$SETTINGS" ]; then
  echo "{}" > "$SETTINGS"
  echo "✓ Created $SETTINGS"
fi

echo ""
echo "Starting setup wizard..."
echo ""

# 3. Run the interactive setup wizard (handles config + settings patching)
node "$SCRIPT_DIR/setup.js"

#!/bin/bash
# inline-claude-usage installer
# Configures Claude Code's statusCommand to show real-time usage metrics.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
CONFIG="$CLAUDE_DIR/inline-claude-usage.json"
STATUS_CMD="node $SCRIPT_DIR/index.js"

echo "inline-claude-usage installer"
echo "=============================="

# 1. Copy example config if no config exists
if [ ! -f "$CONFIG" ]; then
  cp "$SCRIPT_DIR/config.example.json" "$CONFIG"
  echo "✓ Created config at $CONFIG"
  echo "  → Edit it to set your currency, monthly cap, and plan limits."
else
  echo "✓ Config already exists at $CONFIG (skipping)"
fi

# 2. Ensure node is available
if ! command -v node &>/dev/null; then
  echo "✗ node not found. Please install Node.js (https://nodejs.org) and re-run."
  exit 1
fi
echo "✓ Node.js $(node --version) found"

# 3. Patch ~/.claude/settings.json
if [ ! -f "$SETTINGS" ]; then
  echo "{}" > "$SETTINGS"
fi

# Use node to safely patch the JSON (avoids sed/awk edge cases)
node - "$SETTINGS" "$STATUS_CMD" <<'EOF'
const fs   = require('fs');
const file = process.argv[2];
const cmd  = process.argv[3];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
delete cfg.statusCommand; // remove old format if present
cfg.statusLine = { type: 'command', command: cmd };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('✓ statusLine set in ' + file);
EOF

echo ""
echo "All done! Restart Claude Code to see the status line."
echo ""
echo "Status line will show:"
echo "  Model | ctx tokens/200k (%) | cost € | 5h % @reset | 7d % @reset | extra €spent/€cap"
echo ""
echo "To customise limits/currency: edit $CONFIG"

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

# 4. Add 'claude usage' shell function so users can run:
#      claude usage --reconfigure
#    Everything else is passed through to the real claude binary.
MARKER="# inline-claude-usage"
FUNC="$MARKER
claude() {
  if [ \"\$1\" = \"usage\" ]; then
    shift
    case \"\$1\" in
      --start)
        node -e \"
          const fs = require('fs'), p = require('os').homedir() + '/.claude/settings.json';
          let s = {}; try { s = JSON.parse(fs.readFileSync(p,'utf8')); } catch {}
          s.statusLine = { type: 'command', command: 'node $SCRIPT_DIR/index.js' };
          fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\\\n');
          console.log('✓ All set! Open Claude Code in your terminal and your usage bar will appear automatically.');
        \"
        ;;
      *)
        node \"$SCRIPT_DIR/setup.js\" \"\$@\"
        ;;
    esac
  else
    command claude \"\$@\"
  fi
}"

ADDED=0
for RC in "$HOME/.zshrc" "$HOME/.bashrc"; do
  [ -f "$RC" ] || continue
  if ! grep -qF "$MARKER" "$RC"; then
    printf '\n%s\n' "$FUNC" >> "$RC"
    echo "✓ Added 'claude usage' to $RC"
    ADDED=1
  else
    echo "✓ 'claude usage' already in $RC"
    ADDED=1
  fi
done

echo ""
if [ "$ADDED" = "1" ]; then
  echo "  Reload your shell or run:  source ~/.zshrc"
  echo "  Then use:                  claude usage --reconfigure"
else
  echo "  No shell config found (~/.zshrc / ~/.bashrc)."
  echo "  Add this to your shell config manually:"
  echo ""
  echo "    $FUNC"
fi
echo ""

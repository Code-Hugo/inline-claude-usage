# inline-claude-usage

Real-time Claude usage in your terminal status line — powered by Claude Code's `statusCommand`.

```
Sonnet 4.6 | ctx 18k/200k (9%) | cost €0.09 | 5h 17% @1:00pm | 7d 31% @mar 13, 12:00pm | extra €17.43/€20.00 (€2.57 left)
```

Shows:
- **Model** currently in use
- **Context window** — tokens used vs 200k limit
- **Session cost** — cost of the current conversation
- **5h session** — rolling 5-hour usage % and reset time
- **7d weekly** — rolling 7-day usage % and reset time
- **Extra spend** — monthly spend vs your configured cap

All data is read locally from `~/.claude/projects/` — no API calls, no telemetry.

---

## Quick install

```bash
git clone https://github.com/Code-Hugo/inline-claude-usage.git
cd inline-claude-usage
chmod +x install.sh
./install.sh
```

Then restart Claude Code.

## Manual install

1. Clone the repo anywhere, e.g. `~/Code/inline-claude-usage/`
2. Add to `~/.claude/settings.json`:
   ```json
   {
     "statusCommand": "node /path/to/inline-claude-usage/index.js"
   }
   ```
3. Copy the example config:
   ```bash
   cp config.example.json ~/.claude/inline-claude-usage.json
   ```
4. Edit `~/.claude/inline-claude-usage.json` with your settings.

## Configuration

Copy `config.example.json` to `~/.claude/inline-claude-usage.json` and edit:

| Key | Description | Default |
|-----|-------------|---------|
| `currency` | Currency code | `"EUR"` |
| `currencySymbol` | Symbol to display | `"€"` |
| `usdToLocalRate` | USD → your currency conversion rate | `0.92` |
| `monthlyCapUSD` | Your monthly spend cap in USD | `21.74` |
| `sessionLimitTokens` | Token limit for 5h session window | `500000` |
| `weeklyLimitTokens` | Token limit for 7d weekly window | `2500000` |

### USD users

```json
{
  "currency": "USD",
  "currencySymbol": "$",
  "usdToLocalRate": 1.0,
  "monthlyCapUSD": 25.00
}
```

### Claude Pro users

The 5h/7d limits in Claude Pro are compute-based, not strictly token-based. Tune `sessionLimitTokens` and `weeklyLimitTokens` based on your observed usage pattern until the percentages feel accurate.

---

## How it works

1. Reads `~/.claude/projects/**/*.jsonl` — the same files Claude Code writes locally
2. Aggregates token counts over rolling 5h and 7d windows
3. Calculates cost using published Anthropic pricing (configurable)
4. Outputs a single formatted line to stdout → Claude Code displays it in the status bar

## Requirements

- Node.js ≥ 16
- Claude Code

## License

MIT

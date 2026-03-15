# inline-claude-usage

Real-time Claude usage in your Claude Code terminal status line.

```
Sonnet 4.6 | ctx 18k/200k (9%) | cost €0.09
5h 17% @1:00pm | 7d 31% @mar 13, 12:00pm | extra €17.43/€20.00 (€2.57 left)
```

Two lines, always visible — even on narrow terminals.

**What it shows:**

| Field | Description |
|---|---|
| Model | Which Claude model is active |
| ctx | Context window tokens used vs total, with % |
| cost | Cost of the current session |
| 5h | Rolling 5-hour usage % and when it resets |
| 7d | Rolling 7-day usage % and when it resets |
| extra | Monthly spend vs your configured cap |

Colors update with your usage level — green → yellow → red.

All data is read locally from `~/.claude/` — no extra API calls, no telemetry.

---

## Requirements

- [Claude Code](https://claude.ai/code) installed and configured
- [Node.js](https://nodejs.org) v16 or higher

---

## Install

```bash
git clone https://github.com/Code-Hugo/inline-claude-usage.git
cd inline-claude-usage
chmod +x install.sh setup.js index.js
./install.sh
```

`install.sh` checks for Node.js and then launches the interactive **setup wizard** automatically.

---

## Setup wizard

The wizard runs automatically on first install. It walks you through five steps:

### Step 1 — Plan

Choose your Claude plan:

```
  ○ 1. Claude Pro
  ○ 2. Claude Max ($100/mo)
  ○ 3. Claude Max ($200/mo)
  ● 4. Claude Team
  ○ 5. Claude API (pay-as-you-go)
```

- **Pro / Max** — sensible token limit defaults are pre-filled. You can accept them or calibrate (see below).
- **Team** — token limits vary by contract so calibration is required (takes ~30 seconds).
- **API** — no session/weekly limits, only monthly spend cap is tracked.

### Step 2 — Currency

Enter your currency symbol (`€`, `$`, `£`, etc.) and the USD conversion rate.

```
? Currency symbol     [€]:
? USD → € rate        [0.92]:
```

### Step 3 — Monthly spend cap

Enter your monthly budget in your chosen currency. This is used to show how much of your cap you've spent and how much is left.

```
? Monthly cap in €  [€18]:
```

### Step 4 — Usage limits (calibration)

This is how the 5h and 7d percentages are calculated.

**For Pro / Max users**, preset defaults are shown and calibration is optional:

```
  Preset defaults for Claude Pro:
    5h session : 88,000 tokens
    7d weekly  : 440,000 tokens

? Calibrate from live usage? [y/N]:
```

**For Team users**, calibration is required since limits aren't fixed:

```
  Tokens detected in your local history:
    Last 5h : 45,231 tokens
    Last 7d : 187,432 tokens

  Open claude.ai → Settings → Usage, then enter the percentages shown.

? Your current 5-hour session usage % (0 to enter manually): 30
  ✓ 5h session limit estimated: 150,770 tokens

? Your current 7-day weekly usage %   (0 to enter manually): 15
  ✓ 7d weekly limit estimated: 1,249,547 tokens
```

**How calibration works:** You look up your current usage % in Claude's settings, enter it here, and the tool back-calculates your actual token limit from your local usage data. It then uses that limit to compute percentages going forward.

> If you have no recent usage data, you can enter your limits manually in tokens instead.

### Step 5 — Display

```
? Disable status line? [n]:
```

Enter `y` to stop the status line from showing without removing it from Claude Code's settings. Re-run setup to re-enable it.

---

## Reconfiguring

Run setup again at any time — for example if your usage pattern changes and the percentages feel off, or you switch plans:

```bash
node /path/to/inline-claude-usage/setup.js --reconfigure
```

Your existing values are shown as defaults so you only need to change what's different.

---

## How it works

When Claude Code refreshes its status bar, it runs `index.js` and displays the output.

- **Model, context window, session cost** — received directly from Claude Code via stdin (accurate and always current)
- **5h / 7d rolling windows** — calculated by reading `~/.claude/projects/**/*.jsonl`, the local conversation logs Claude Code writes automatically
- **Monthly spend** — aggregated from the same JSONL files using published Anthropic pricing
- **Config** — stored at `~/.claude/inline-claude-usage.json`

### First run behaviour

If no config file is found, the status line shows a setup prompt instead of usage data:

```
⚙ inline-claude-usage not configured — run: node /path/to/setup.js
```

Run the command shown, complete the wizard, then restart Claude Code.

### Disabling

To stop the status line from showing without uninstalling, either:

- Re-run setup and answer `y` at Step 5, **or**
- Set `"disabled": true` in `~/.claude/inline-claude-usage.json`

To remove it entirely, delete the `statusLine` entry from `~/.claude/settings.json`.

---

## Config file reference

Located at `~/.claude/inline-claude-usage.json` after setup.

| Key | Type | Description |
|---|---|---|
| `plan` | string | Your plan key: `pro`, `max100`, `max200`, `team`, `api` |
| `currencySymbol` | string | Symbol shown in output, e.g. `€` |
| `usdToLocalRate` | number | USD to your currency conversion rate |
| `monthlyCapUSD` | number | Your monthly spend cap converted to USD |
| `sessionLimitTokens` | number | Token limit for the 5h rolling window |
| `weeklyLimitTokens` | number | Token limit for the 7d rolling window |
| `sessionWindowHours` | number | Session window size in hours (default: 5) |
| `weeklyWindowDays` | number | Weekly window size in days (default: 7) |
| `disabled` | boolean | Set to `true` to hide the status line |
| `pricing` | object | Per-model pricing in USD per million tokens |

---

## FAQ

**The 5h / 7d percentages are showing 100% — why?**

Your configured token limits are probably lower than your actual usage. Re-run setup and calibrate from your current usage % in Claude's settings.

**I'm on Team plan and don't have any recent usage data for calibration.**

Use Claude for a bit first, then run `node setup.js --reconfigure`. Alternatively, enter your limits manually in tokens — your team admin may be able to tell you the contract limits.

**The cost shown doesn't match Claude's billing exactly.**

Cost is estimated from local token counts using published Anthropic pricing. Minor differences are normal. For exact billing, check claude.ai.

**Can I use USD instead of EUR?**

Yes — in setup, enter `$` as your symbol and `1` as the conversion rate.

---

## License

MIT

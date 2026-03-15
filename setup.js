#!/usr/bin/env node
'use strict';

/**
 * inline-claude-usage — Setup wizard
 * Run once to configure, or anytime with --reconfigure to update.
 * https://github.com/Code-Hugo/inline-claude-usage
 */

const readline = require('readline');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_PATH   = path.join(os.homedir(), '.claude', 'inline-claude-usage.json');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const INDEX_PATH    = path.join(__dirname, 'index.js');

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const bold   = t => `\x1b[1m${t}\x1b[0m`;
const dim    = t => `\x1b[2m${t}\x1b[0m`;
const green  = t => `\x1b[32m${t}\x1b[0m`;
const cyan   = t => `\x1b[36m${t}\x1b[0m`;
const yellow = t => `\x1b[33m${t}\x1b[0m`;

// ── Timezone ──────────────────────────────────────────────────────────────────

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Convert local date/time components to UTC (DST-safe, iterative correction).
function localToUTC(year, month0, day, hour, minute) {
  let guess = new Date(Date.UTC(year, month0, day, hour, minute));
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(guess).filter(x => x.type !== 'literal').map(x => [x.type, +x.value])
    );
    const gotMs  = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
    const wantMs = Date.UTC(year, month0, day, hour, minute);
    if (Math.abs(gotMs - wantMs) < 60_000) break;
    guess = new Date(guess.getTime() + (wantMs - gotMs));
  }
  return guess;
}

// Return local date/time components for `date` in the user's TZ.
function localParts(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric',
      weekday: 'short', hour12: false,
    }).formatToParts(date)
      .filter(x => x.type !== 'literal')
      .map(x => [x.type, x.value])
  );
  const DOW = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    year:   +p.year,
    month:  +p.month - 1,
    day:    +p.day,
    hour:   +p.hour % 24,
    minute: +p.minute,
    dow:    DOW[p.weekday] ?? 0,
  };
}

// Get today's local date components (year, month0, day) in the user's TZ.
function todayLocal() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, +x.value])
  );
  return { year: p.year, month0: p.month - 1, day: p.day };
}

// ── Parse session reset input ─────────────────────────────────────────────────
// Accepts: "4h 18m", "4:18" (h:m), "6:03 PM", "18:03"
// Returns a UTC Date or null.
function parseSessionReset(input) {
  const now = new Date();
  // Strip natural-language prefixes ("Resets in", "Resets its", "in", etc.)
  // and connectors ("and") to support copy-paste from Claude's UI.
  const s = input.trim().toLowerCase()
    .replace(/^resets?\s+(in|its|at)?\s*/i, '')
    .replace(/\band\b\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Relative: "4h 18m", "4h18m", "2h", "45m", "45min"
  const relH = s.match(/^(\d+)\s*h(?:\s*(\d+)\s*m(?:in)?)?$/);
  if (relH) {
    const h = parseInt(relH[1]);
    const m = parseInt(relH[2] || '0');
    return new Date(now.getTime() + (h * 60 + m) * 60_000);
  }
  const relM = s.match(/^(\d+)\s*m(?:in)?$/);
  if (relM) return new Date(now.getTime() + parseInt(relM[1]) * 60_000);

  // Relative shorthand: "4:18" treated as h:m remaining (only if h < 6)
  const colonRel = s.match(/^(\d):(\d{2})$/);
  if (colonRel) {
    return new Date(now.getTime() + (parseInt(colonRel[1]) * 60 + parseInt(colonRel[2])) * 60_000);
  }

  // Absolute: "6:03 pm", "18:03", "6:03pm"
  const absMatch = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (absMatch) {
    let h = parseInt(absMatch[1]);
    const m = parseInt(absMatch[2]);
    const ampm = absMatch[3];
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    const { year, month0, day } = todayLocal();
    const reset = localToUTC(year, month0, day, h, m);
    // If the parsed time is in the past (e.g. user typed tomorrow's time today), add nothing
    return reset > now ? reset : null;
  }

  return null;
}

// ── Parse weekly reset input ──────────────────────────────────────────────────
// Accepts: "Sun 1:00 PM", "Sunday 13:00", "Mon 9:30 AM", etc.
// Returns { day, hour, minute } or null.
function parseWeeklyReset(input) {
  const DOW_MAP = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  const s = input.trim().toLowerCase();
  const dayMatch = s.match(/^(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)/);
  if (!dayMatch) return null;
  const day = DOW_MAP[dayMatch[1]];
  const timeMatch = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (!timeMatch) return null;
  let hour = parseInt(timeMatch[1]);
  const minute = parseInt(timeMatch[2]);
  const ampm = timeMatch[3];
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return { day, hour, minute };
}

// ── Currency presets ──────────────────────────────────────────────────────────

const CURRENCIES = [
  { symbol: '€', code: 'EUR', rate: 0.92  },
  { symbol: '$', code: 'USD', rate: 1.00  },
  { symbol: '£', code: 'GBP', rate: 0.79  },
  { symbol: '¥', code: 'JPY', rate: 149.5 },
  { symbol: 'Fr', code: 'CHF', rate: 0.88  },
  { symbol: 'CA$', code: 'CAD', rate: 1.36  },
  { symbol: 'AU$', code: 'AUD', rate: 1.53  },
];

// ── Plan presets ──────────────────────────────────────────────────────────────

const PLANS = [
  { key: 'pro',    label: 'Claude Pro',           monthlyCapUSD: 20,  sessionTokens:  88_000, weeklyTokens:   440_000, hasLimits: true,  calibrate: false },
  { key: 'max100', label: 'Claude Max ($100/mo)', monthlyCapUSD: 100, sessionTokens: 500_000, weeklyTokens: 2_500_000, hasLimits: true,  calibrate: false },
  { key: 'max200', label: 'Claude Max ($200/mo)', monthlyCapUSD: 200, sessionTokens: 1_000_000, weeklyTokens: 5_000_000, hasLimits: true, calibrate: false },
  { key: 'team',   label: 'Claude Team',          monthlyCapUSD: null, sessionTokens: null, weeklyTokens: null, hasLimits: true, calibrate: true },
  { key: 'api',    label: 'Claude API (pay-as-you-go)', monthlyCapUSD: null, sessionTokens: null, weeklyTokens: null, hasLimits: false, calibrate: false },
];

// ── Readline helper ───────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

// ── Arrow-key list selector ───────────────────────────────────────────────────
// Renders an interactive list; returns the selected index.
// Falls back to number input when stdin is not a TTY.

async function selectFromList(items, defaultIdx, labelFn) {
  const render = (selected) => {
    items.forEach((item, i) => {
      const marker = i === selected ? green('●') : dim('○');
      process.stdout.write(`    ${marker} ${i + 1}. ${labelFn(item)}\n`);
    });
    process.stdout.write('\n');
  };

  // Non-TTY fallback (piped input, tests, etc.)
  if (!process.stdin.isTTY) {
    render(defaultIdx);
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`  ${cyan('?')} Select [1–${items.length}]${dim(` [${defaultIdx + 1}]`)}: `, ans => {
        rl.close();
        const idx = parseInt(ans || String(defaultIdx + 1), 10) - 1;
        resolve(idx >= 0 && idx < items.length ? idx : defaultIdx);
      });
    });
  }

  render(defaultIdx);
  process.stdout.write(`  ${cyan('?')} Use ↑ ↓ arrows then Enter`);

  return new Promise(resolve => {
    let selected = defaultIdx;

    const redraw = () => {
      // Move cursor up past: items + blank line + prompt line
      process.stdout.write(`\r\x1b[K\x1b[${items.length + 1}A`);
      render(selected);
      process.stdout.write(`  ${cyan('?')} Use ↑ ↓ arrows then Enter`);
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onKey = (key) => {
      if (key === '\x1b[A') {                         // up arrow
        selected = (selected - 1 + items.length) % items.length;
        redraw();
      } else if (key === '\x1b[B') {                  // down arrow
        selected = (selected + 1) % items.length;
        redraw();
      } else if (key >= '1' && key <= String(items.length)) { // number shortcut
        selected = parseInt(key) - 1;
        redraw();
      } else if (key === '\r' || key === '\n') {       // enter
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(selected);
      } else if (key === '\x03') {                    // ctrl+c
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        process.exit(0);
      }
    };

    process.stdin.on('data', onKey);
  });
}

// ── Horizontal left/right selector ───────────────────────────────────────────
// Shows items inline; ← → arrows navigate, Enter confirms.

async function selectHorizontal(items, defaultIdx, labelFn, sublineFn) {
  const lineCount = sublineFn ? 2 : 1;

  const render = (selected, first) => {
    if (!first) process.stdout.write(`\x1b[${lineCount}A`);
    const row = items.map((item, i) => {
      const lbl = labelFn(item, i);
      return i === selected ? cyan(`[${lbl}]`) : dim(lbl);
    }).join('   ');
    process.stdout.write(`\r\x1b[K    ← ${row} →\n`);
    if (sublineFn) process.stdout.write(`\r\x1b[K    ${sublineFn(items[selected], selected)}\n`);
  };

  if (!process.stdin.isTTY) {
    render(defaultIdx, true);
    return defaultIdx;
  }

  render(defaultIdx, true);

  return new Promise(resolve => {
    let selected = defaultIdx;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onKey = (key) => {
      if (key === '\x1b[D') {                          // left arrow
        selected = (selected - 1 + items.length) % items.length;
        render(selected, false);
      } else if (key === '\x1b[C') {                   // right arrow
        selected = (selected + 1) % items.length;
        render(selected, false);
      } else if (key === '\r' || key === '\n') {        // enter
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(selected);
      } else if (key === '\x03') {                     // ctrl+c
        process.stdin.removeListener('data', onKey);
        process.stdin.setRawMode(false);
        process.exit(0);
      }
    };

    process.stdin.on('data', onKey);
  });
}

// ── Token counting ────────────────────────────────────────────────────────────
// Counts compute-meaningful tokens only (excludes cache_read — same as index.js).

function countTokensSince(claudeDir, cutoff) {
  const projectsDir = path.join(claudeDir, 'projects');
  let total = 0;
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, project);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              if (e.type !== 'assistant' || !e.message?.usage || !e.timestamp) continue;
              if (new Date(e.timestamp) < cutoff) continue;
              const u = e.message.usage;
              total += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  return total;
}

// ── Settings patcher ──────────────────────────────────────────────────────────

function patchSettings() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
  delete cfg.statusCommand;
  cfg.statusLine = { type: 'command', command: `node ${INDEX_PATH}` };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const claudeDir  = path.join(os.homedir(), '.claude');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

  const existingPlan = PLANS.find(p => p.key === existing.plan);
  const isReconfig   = process.argv.includes('--reconfigure') || process.argv.includes('--configure') || Object.keys(existing).length > 0;
  const now = new Date();

  console.log('');
  console.log(bold(cyan('  inline-claude-usage  ·  Setup')));
  console.log(dim('  ──────────────────────────────────────────'));
  if (isReconfig) {
    console.log(yellow('  Reconfiguring — press Enter to keep existing values.\n'));
  } else {
    console.log(dim('  Takes about 2 minutes. Have claude.ai open in your browser.\n'));
  }

  // ── Step 1 — Plan (arrow-key selector, runs before rl so raw mode works) ──
  console.log(bold('  Step 1 — Your plan\n'));
  const defPlanIdx = existingPlan ? PLANS.indexOf(existingPlan) : 0;
  const planIdx    = await selectFromList(PLANS, defPlanIdx, p => p.label);
  const plan       = PLANS[planIdx];
  console.log(`  ${green('✓')} ${plan.label}\n`);

  // ── Step 2a — Currency picker (raw mode, before rl) ───────────────────────
  console.log(bold('  Step 2 — Currency\n'));
  console.log(`  ${dim('Use ← → to select, Enter to confirm.')}\n`);
  const defCurrencyIdx = Math.max(0,
    CURRENCIES.findIndex(c => c.code === existing.currencyCode) ||
    CURRENCIES.findIndex(c => c.symbol === existing.currencySymbol)
  );
  const currencyIdx = await selectHorizontal(
    CURRENCIES, defCurrencyIdx,
    c => `${c.symbol} ${c.code}`,
    c => dim(`Exchange rate: 1 USD = ${c.rate} ${c.code}`)
  );
  const currency = CURRENCIES[currencyIdx];
  console.log(`\n  ${green('✓')} ${currency.symbol} ${currency.code}\n`);

  // ── Step 2b — Rate (text, allows override) ────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const defRate = existing.usdToLocalRate || currency.rate;
  const rateRaw = await ask(rl, `  ${cyan('?')} Exchange rate        ${dim(`[1 USD = ${defRate} ${currency.code}]`)}: `);
  const rate    = parseFloat(rateRaw) || defRate;
  const sym     = currency.symbol;
  console.log('');

  // ── Step 3 — Monthly spend cap ────────────────────────────────────────────
  console.log(bold('  Step 3 — Monthly spend cap\n'));
  if (plan.key === 'team') {
    console.log(`  ${dim('On Team plan, billing goes to your organisation.')}`);
    console.log(`  ${dim("You may not have a personal budget — it's fine to say no.")}\n`);
  }
  const knowCapRaw = await ask(rl, `  ${cyan('?')} Do you have a monthly budget for Claude? ${dim('[y/N]')}: `);
  const knowCap    = knowCapRaw.toLowerCase() === 'y';

  let capUSD = 0;
  if (knowCap) {
    const defCapLocal = existing.monthlyCapUSD
      ? (existing.monthlyCapUSD * rate).toFixed(0)
      : plan.monthlyCapUSD ? (plan.monthlyCapUSD * rate).toFixed(0) : '';
    const capRaw  = await ask(rl, `  ${cyan('?')} Monthly budget in ${sym}${defCapLocal ? dim(` [${sym}${defCapLocal}]`) : ''}: `);
    const capLocal = parseFloat(capRaw) || parseFloat(defCapLocal) || 0;
    capUSD = capLocal / rate;
    console.log(`  ${green('✓')} Budget set to ${sym}${capLocal.toFixed(0)}/month\n`);
  } else {
    console.log(`  ${green('✓')} No budget — will show monthly spend only\n`);
  }
  console.log('');

  // ── Step 4 — Calibrate from Claude's UI ───────────────────────────────────
  // All limit and reset data comes from claude.ai → Settings → Usage.
  // Doing it in one step so the user only needs to open that page once.

  let sessionLimitTokens = plan.sessionTokens || existing.sessionLimitTokens || 500_000;
  let weeklyLimitTokens  = plan.weeklyTokens  || existing.weeklyLimitTokens  || 2_500_000;
  let sessionSnapshot    = null;  // { resetAt: ISO string } — used until the session resets

  const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let weeklyResetDay    = existing.weeklyResetDay    ?? 0;
  let weeklyResetHour   = existing.weeklyResetHour   ?? 13;
  let weeklyResetMinute = existing.weeklyResetMinute ?? 0;

  if (plan.hasLimits) {
    console.log(bold('  Step 4 — Calibrate from Claude\'s UI\n'));
    console.log(`  ${dim('Open')} ${cyan('claude.ai → Settings → Usage')} ${dim('and enter what you see there.')}`);
    console.log(`  ${dim('Everything in this step comes from that one page. Press Enter to skip any field.\n')}`);

    // ── Session ──────────────────────────────────────────────────────────────
    console.log(`  ${bold('Current session')}`);

    // Ask for reset time FIRST so we can count tokens from the actual session
    // start (not a blind 5h rolling window that may include a prior session).
    const resetInRaw = await ask(rl, `  ${cyan('?')} Resets in / at        ${dim('(e.g. 4h 18m  or  6:03 PM)')}: `);
    let sessionStart5h = new Date(Date.now() - 5 * 3_600_000); // fallback
    if (resetInRaw) {
      const resetDate = parseSessionReset(resetInRaw);
      if (resetDate && resetDate > now) {
        sessionSnapshot = { resetAt: resetDate.toISOString(), capturedAt: now.toISOString() };
        sessionStart5h  = new Date(resetDate.getTime() - 5 * 3_600_000);
        const localTime = new Intl.DateTimeFormat('en-US', {
          timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(resetDate).toLowerCase();
        console.log(`  ${green('✓')} Session anchored — resets at ${localTime}`);
      } else {
        console.log(`  ${yellow('!')} Could not parse "${resetInRaw}" — will estimate from usage history`);
      }
    }

    // Count tokens from actual session start for accurate calibration
    const tokens5h = countTokensSince(claudeDir, sessionStart5h);

    // Weekly: tokens since the last actual weekly reset (not rolling 7 days).
    // Use the reset day/time already configured (or defaults) so calibration
    // matches the same window that index.js will use going forward.
    const weeklyResetCutoff = (() => {
      const resetDow = existing.weeklyResetDay ?? 0;
      const resetHour = existing.weeklyResetHour ?? 13;
      const resetMinute = existing.weeklyResetMinute ?? 0;
      const n = new Date();
      for (let i = 0; i <= 7; i++) {
        const probe = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - i, 12, 0));
        const lp = localParts(probe);
        if (lp.dow !== resetDow) continue;
        const candidate = localToUTC(lp.year, lp.month, lp.day, resetHour, resetMinute);
        if (candidate <= n) return candidate;
        return localToUTC(lp.year, lp.month, lp.day - 7, resetHour, resetMinute);
      }
      return new Date(n.getTime() - 7 * 86_400_000);
    })();
    const tokensWeekly = countTokensSince(claudeDir, weeklyResetCutoff);

    if (plan.calibrate || !plan.sessionTokens) {
      // Team / unknown: derive limit from % + local token count
      if (tokens5h > 0) {
        const pctRaw = await ask(rl, `  ${cyan('?')} Usage % shown          ${dim('(e.g. 17)')}: `);
        const p = parseFloat(pctRaw);
        if (p > 0 && p <= 100) {
          sessionLimitTokens = Math.round(tokens5h / (p / 100));
          console.log(`  ${green('✓')} Session limit estimated: ${dim(sessionLimitTokens.toLocaleString())} tokens`);
        }
      } else {
        const manualRaw = await ask(rl, `  ${cyan('?')} Session token limit    ${dim('[500000]')}: `);
        sessionLimitTokens = parseInt(manualRaw, 10) || 500_000;
      }
    } else {
      // Pro/Max: preset defaults — optionally override with live %
      const pctRaw = await ask(rl, `  ${cyan('?')} Usage % shown          ${dim(`(Enter to use preset ${sessionLimitTokens.toLocaleString()})`)}: `);
      const p = parseFloat(pctRaw);
      if (p > 0 && p <= 100 && tokens5h > 0) {
        sessionLimitTokens = Math.round(tokens5h / (p / 100));
        console.log(`  ${green('✓')} Session limit calibrated: ${dim(sessionLimitTokens.toLocaleString())} tokens`);
      }
    }
    console.log('');

    // ── Weekly ───────────────────────────────────────────────────────────────
    console.log(`  ${bold('Weekly limits (All models)')}`);

    if (plan.calibrate || !plan.weeklyTokens) {
      if (tokensWeekly > 0) {
        const pctRaw = await ask(rl, `  ${cyan('?')} Usage % shown          ${dim('(e.g. 3)')}: `);
        const p = parseFloat(pctRaw);
        if (p > 0 && p <= 100) {
          weeklyLimitTokens = Math.round(tokensWeekly / (p / 100));
          console.log(`  ${green('✓')} Weekly limit estimated: ${dim(weeklyLimitTokens.toLocaleString())} tokens`);
        }
      } else {
        const manualRaw = await ask(rl, `  ${cyan('?')} Weekly token limit     ${dim('[2500000]')}: `);
        weeklyLimitTokens = parseInt(manualRaw, 10) || 2_500_000;
      }
    } else {
      const pctRaw = await ask(rl, `  ${cyan('?')} Usage % shown          ${dim(`(Enter to use preset ${weeklyLimitTokens.toLocaleString()})`)}: `);
      const p = parseFloat(pctRaw);
      if (p > 0 && p <= 100 && tokensWeekly > 0) {
        weeklyLimitTokens = Math.round(tokensWeekly / (p / 100));
        console.log(`  ${green('✓')} Weekly limit calibrated: ${dim(weeklyLimitTokens.toLocaleString())} tokens`);
      }
    }

    // Weekly reset schedule — user reads "Resets Sun 1:00 PM" from Claude's UI
    const defResetStr = `${DOW_NAMES[weeklyResetDay]} ${weeklyResetHour % 12 || 12}:${String(weeklyResetMinute).padStart(2,'0')} ${weeklyResetHour >= 12 ? 'PM' : 'AM'}`;
    const weeklyResetRaw = await ask(rl, `  ${cyan('?')} Resets on             ${dim(`(e.g. Sun 1:00 PM) [${defResetStr}]`)}: `);
    if (weeklyResetRaw) {
      const parsed = parseWeeklyReset(weeklyResetRaw);
      if (parsed) {
        weeklyResetDay    = parsed.day;
        weeklyResetHour   = parsed.hour;
        weeklyResetMinute = parsed.minute;
      } else {
        console.log(`  ${yellow('!')} Could not parse "${weeklyResetRaw}" — keeping existing value`);
      }
    }
    const weeklyLabel = `${DOW_NAMES[weeklyResetDay]} ${weeklyResetHour % 12 || 12}:${String(weeklyResetMinute).padStart(2,'0')} ${weeklyResetHour >= 12 ? 'PM' : 'AM'}`;
    console.log(`  ${green('✓')} Weekly resets every ${weeklyLabel}\n`);
  }

  // ── Step 5 — Display ──────────────────────────────────────────────────────
  console.log(bold('  Step 5 — Display\n'));
  console.log(`  ${dim('Should the usage status line appear in your Claude Code terminal?')}\n`);
  const showRaw  = await ask(rl, `  ${cyan('?')} Show status line?     ${dim('[Y/n]')}: `);
  const disabled = showRaw.toLowerCase() === 'n';
  console.log(`  ${green('✓')} Status line ${disabled ? 'disabled' : 'enabled'}\n`);

  rl.close();

  // ── Write config ──────────────────────────────────────────────────────────
  const config = {
    plan: plan.key,
    currencySymbol: sym,
    currencyCode: currency.code,
    usdToLocalRate: rate,
    monthlyCapUSD: parseFloat(capUSD.toFixed(4)),
    sessionLimitTokens,
    weeklyLimitTokens,
    sessionWindowHours: 5,
    weeklyResetDay,
    weeklyResetHour,
    weeklyResetMinute,
    ...(sessionSnapshot ? { sessionSnapshot } : {}),
    disabled,
    pricing: {
      'claude-opus-4-6':           { input: 15.00, cacheRead: 1.50, cacheWrite: 18.75, output: 75.00 },
      'claude-sonnet-4-6':         { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
      'claude-sonnet-4-5':         { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
      'claude-haiku-4-5':          { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
      'claude-haiku-4-5-20251001': { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
    }
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log(`  ${green('✓')} Config saved to ${dim(CONFIG_PATH)}`);

  try {
    patchSettings();
    console.log(`  ${green('✓')} statusLine configured in ${dim(SETTINGS_PATH)}`);
  } catch (e) {
    console.log(`  ${yellow('!')} Could not update settings.json — add manually:`);
    console.log(dim(`    "statusLine": { "type": "command", "command": "node ${INDEX_PATH}" }`));
  }

  console.log('');
  console.log(bold(green('  ✓ You\'re all set!')));
  console.log('');
  if (disabled) {
    console.log(yellow('  Status line is currently disabled.'));
    console.log(dim('  Run claude usage --reconfigure and say Y at Step 5 to enable it.'));
  } else {
    console.log('  Next time you open Claude Code in your terminal,');
    console.log(bold('  your usage bar will appear automatically at the bottom of the screen.'));
    console.log('');
    console.log(dim('  Already have Claude Code open? Just restart it to see it.'));
    console.log(dim('  To update your settings anytime: claude usage --reconfigure'));
  }
  console.log('');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

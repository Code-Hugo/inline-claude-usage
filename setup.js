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
  const s = input.trim().toLowerCase();

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
  const isReconfig   = process.argv.includes('--reconfigure') || Object.keys(existing).length > 0;
  const now = new Date();

  console.log('');
  console.log(bold(cyan('  inline-claude-usage  ·  Setup')));
  console.log(dim('  ──────────────────────────────────────────'));
  if (isReconfig) {
    console.log(yellow('  Reconfiguring — press Enter to keep existing values.\n'));
  } else {
    console.log(dim('  Takes about 2 minutes. Have claude.ai open in your browser.\n'));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── Step 1 — Plan ─────────────────────────────────────────────────────────
  console.log(bold('  Step 1 — Your plan\n'));
  PLANS.forEach((p, i) => {
    const marker = existingPlan?.key === p.key ? green('●') : dim('○');
    console.log(`    ${marker} ${i + 1}. ${p.label}`);
  });
  console.log('');

  const defPlanIdx = existingPlan ? PLANS.indexOf(existingPlan) + 1 : '';
  let plan;
  while (!plan) {
    const raw = await ask(rl, `  ${cyan('?')} Select plan [1–${PLANS.length}]${defPlanIdx ? dim(` [${defPlanIdx}]`) : ''}: `);
    const idx = parseInt(raw || defPlanIdx, 10) - 1;
    if (idx >= 0 && idx < PLANS.length) plan = PLANS[idx];
    else console.log(yellow(`  Please enter a number between 1 and ${PLANS.length}.`));
  }
  console.log(`  ${green('✓')} ${plan.label}\n`);

  // ── Step 2 — Currency ─────────────────────────────────────────────────────
  console.log(bold('  Step 2 — Currency\n'));
  const defSym  = existing.currencySymbol || '€';
  const defRate = existing.usdToLocalRate  || 0.92;

  const symRaw  = await ask(rl, `  ${cyan('?')} Currency symbol      ${dim(`[${defSym}]`)}: `);
  const sym     = symRaw || defSym;
  const rateRaw = await ask(rl, `  ${cyan('?')} USD → ${sym} rate        ${dim(`[${defRate}]`)}: `);
  const rate    = parseFloat(rateRaw) || defRate;
  console.log('');

  // ── Step 3 — Monthly spend cap ────────────────────────────────────────────
  console.log(bold('  Step 3 — Monthly spend cap\n'));
  const defCapLocal = existing.monthlyCapUSD
    ? (existing.monthlyCapUSD * rate).toFixed(0)
    : plan.monthlyCapUSD ? (plan.monthlyCapUSD * rate).toFixed(0) : null;

  console.log(`  ${dim("If you're on a Team plan or don't know your cap, type \"skip\" to just track spend.")}\n`);
  const capRaw   = await ask(rl, `  ${cyan('?')} Monthly cap in ${sym}${defCapLocal ? dim(` [${sym}${defCapLocal}]`) : ''}: `);
  const skipCap  = !capRaw || ['skip','no','?','unknown','idk'].includes(capRaw.toLowerCase());
  const capLocal = skipCap ? 0 : (parseFloat(capRaw) || (defCapLocal ? parseFloat(defCapLocal) : 0));
  const capUSD   = capLocal / rate;
  if (skipCap) console.log(`  ${green('✓')} No cap set — will show monthly spend only\n`);
  else console.log('');
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

    // Session: rolling 5h window
    const tokens5h = countTokensSince(claudeDir, new Date(Date.now() - 5 * 3_600_000));

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

    // ── Session ──────────────────────────────────────────────────────────────
    console.log(`  ${bold('Current session')}`);

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

    // Session reset time — user reads "Resets in 4h 18m" from Claude's UI
    const resetInRaw = await ask(rl, `  ${cyan('?')} Resets in / at        ${dim('(e.g. 4h 18m  or  6:03 PM)')}: `);
    if (resetInRaw) {
      const resetDate = parseSessionReset(resetInRaw);
      if (resetDate && resetDate > now) {
        sessionSnapshot = { resetAt: resetDate.toISOString(), capturedAt: now.toISOString() };
        const localTime = new Intl.DateTimeFormat('en-US', {
          timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true,
        }).format(resetDate).toLowerCase();
        console.log(`  ${green('✓')} Session anchored — resets at ${localTime}`);
      } else {
        console.log(`  ${yellow('!')} Could not parse "${resetInRaw}" — will estimate from usage history`);
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
  const defDisabled = existing.disabled === true ? 'Y' : 'n';
  const disableRaw  = await ask(rl, `  ${cyan('?')} Disable status line?  ${dim(`[${defDisabled}]`)}: `);
  const disabled    = disableRaw === '' ? existing.disabled === true : disableRaw.toLowerCase() === 'y';
  console.log('');

  rl.close();

  // ── Write config ──────────────────────────────────────────────────────────
  const config = {
    plan: plan.key,
    currencySymbol: sym,
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
  console.log(bold(green('  All done!')));
  if (disabled) {
    console.log(yellow('  Status line is disabled. Re-run setup to enable it.'));
  } else {
    console.log('  Restart Claude Code to see your status line.');
  }
  console.log('');
  console.log(dim(`  To reconfigure: node ${path.join(__dirname, 'setup.js')} --reconfigure`));
  console.log('');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

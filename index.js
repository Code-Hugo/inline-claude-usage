#!/usr/bin/env node
'use strict';

/**
 * inline-claude-usage
 * Real-time Claude usage in your terminal status line.
 * https://github.com/Code-Hugo/inline-claude-usage
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'inline-claude-usage.json');

const DEFAULTS = {
  currencySymbol: '€',
  usdToLocalRate: 0.92,
  monthlyCapUSD: 21.74,
  sessionLimitTokens: 500000,
  weeklyLimitTokens: 2500000,
  sessionWindowHours: 5,
  // Weekly reset: fixed day/time schedule (matches claude.ai → Settings → Usage)
  weeklyResetDay: 0,     // 0 = Sunday
  weeklyResetHour: 13,   // 1:00 PM
  weeklyResetMinute: 0,
  pricing: {
    'claude-opus-4-6':           { input: 15.00, cacheRead: 1.50, cacheWrite: 18.75, output: 75.00 },
    'claude-sonnet-4-6':         { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
    'claude-sonnet-4-5':         { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
    'claude-haiku-4-5':          { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
    'claude-haiku-4-5-20251001': { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
  }
};

function configExists() {
  try { fs.accessSync(CONFIG_PATH); return true; } catch { return false; }
}

function loadConfig() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return DEFAULTS;
  }
}

// ── JSONL Reader ──────────────────────────────────────────────────────────────

function parseJSONLFile(filePath) {
  const entries = [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'assistant' && e.message?.usage && e.timestamp) {
          entries.push({
            timestamp: new Date(e.timestamp),
            model:     e.message.model || 'claude-sonnet-4-6',
            usage:     e.message.usage,
          });
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* skip unreadable */ }
  return entries;
}

function collectAllEntries(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const entries = [];
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, project);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        entries.push(...parseJSONLFile(path.join(dir, file)));
      }
    }
  } catch {}
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Costs ─────────────────────────────────────────────────────────────────────

function costUSD(usage, model, pricing) {
  const p = pricing[model] || pricing['claude-sonnet-4-6'];
  const M = 1_000_000;
  return ((usage.input_tokens               || 0) / M) * p.input
       + ((usage.cache_read_input_tokens     || 0) / M) * p.cacheRead
       + ((usage.cache_creation_input_tokens || 0) / M) * p.cacheWrite
       + ((usage.output_tokens               || 0) / M) * p.output;
}

function totalTokens(usage) {
  return (usage.input_tokens               || 0)
       + (usage.cache_read_input_tokens     || 0)
       + (usage.cache_creation_input_tokens || 0)
       + (usage.output_tokens               || 0);
}

function pct(used, total) {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

// ── Colours ───────────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  dim:    '\x1b[2m',
};

function usageColor(p) {
  if (p >= 90) return C.red;
  if (p >= 60) return C.yellow;
  return C.green;
}

function c(color, text) { return `${color}${text}${C.reset}`; }

// ── Timezone ──────────────────────────────────────────────────────────────────
// Detect system timezone once at startup. Used explicitly in all date/time
// formatting and arithmetic so output is correct regardless of how the
// Claude Code subprocess inherits (or doesn't inherit) the TZ env var.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── Timezone-aware date helpers ───────────────────────────────────────────────

// Return the local date/time components of `date` in `tz`.
function localParts(date, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric',
      weekday: 'short', hour12: false,
    }).formatToParts(date)
      .filter(x => x.type !== 'literal')
      .map(x => [x.type, x.value])
  );
  const DOW = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    year:    +p.year,
    month:   +p.month - 1,   // 0-indexed
    day:     +p.day,
    hour:    +p.hour % 24,   // Intl can return 24 for midnight
    minute:  +p.minute,
    dow:     DOW[p.weekday] ?? 0,
  };
}

// Convert local date/time components in `tz` to a UTC Date.
// Uses iterative correction to handle DST transitions correctly.
function localToUTC(year, month0, day, hour, minute, tz) {
  let guess = new Date(Date.UTC(year, month0, day, hour, minute));
  for (let i = 0; i < 4; i++) {
    const lp = localParts(guess, tz);
    const gotMs  = Date.UTC(lp.year, lp.month, lp.day, lp.hour, lp.minute);
    const wantMs = Date.UTC(year, month0, day, hour, minute);
    if (Math.abs(gotMs - wantMs) < 60_000) break;
    guess = new Date(guess.getTime() + (wantMs - gotMs));
  }
  return guess;
}

// Find the most recent past occurrence of (resetDow at resetHour:resetMinute)
// in the user's timezone. This is the start of the current weekly window.
function getLastWeeklyReset(now, tz, resetDow, resetHour, resetMinute) {
  // Walk back day by day (max 8). Anchor each probe at noon UTC to avoid
  // DST edge cases when crossing day boundaries.
  for (let i = 0; i <= 7; i++) {
    const probe = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i, 12, 0
    ));
    const lp = localParts(probe, tz);
    if (lp.dow !== resetDow) continue;

    const candidate = localToUTC(lp.year, lp.month, lp.day, resetHour, resetMinute, tz);
    if (candidate <= now) return candidate;
    // Reset time on this day is still in the future — go back one more week
    return localToUTC(lp.year, lp.month, lp.day - 7, resetHour, resetMinute, tz);
  }
  return new Date(now.getTime() - 7 * 86_400_000); // fallback
}

function getNextWeeklyReset(now, tz, resetDow, resetHour, resetMinute) {
  const last = getLastWeeklyReset(now, tz, resetDow, resetHour, resetMinute);
  return new Date(last.getTime() + 7 * 86_400_000);
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date).toLowerCase();
}

// Countdown from now to a future date: "in 4h 18m" — mirrors Claude's UI
function fmtCountdown(future, now) {
  const ms = future - now;
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

// Day-name + time: "sun 1:00pm" — mirrors Claude's weekly reset display
const DOW_SHORT = ['sun','mon','tue','wed','thu','fri','sat'];
function fmtWeeklyReset(resetDow, nextReset) {
  return `${DOW_SHORT[resetDow]} ${fmtTime(nextReset)}`;
}

function fmtTokens(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(claudeData) {
  // Not configured yet — prompt user to run setup
  if (!configExists()) {
    const setupPath = path.join(__dirname, 'setup.js');
    process.stdout.write(`\x1b[33m⚙ inline-claude-usage not configured\x1b[0m\x1b[2m — run: node ${setupPath}\x1b[0m\n`);
    return;
  }

  const cfg = loadConfig();

  // Disabled by user preference — output nothing
  if (cfg.disabled) return;

  const claudeDir = path.join(os.homedir(), '.claude');
  const now       = new Date();

  // ── From Claude Code stdin ─────────────────────────────────────────────────
  const modelName        = claudeData?.model?.display_name || 'Claude';
  const ctxUsedPct       = Math.floor(claudeData?.context_window?.used_percentage || 0);
  const ctxTotal         = claudeData?.context_window?.context_window_size || 200_000;
  const ctxUsed          = claudeData?.context_window?.total_input_tokens || 0;
  const sessionCostUSD   = claudeData?.cost?.total_cost_usd || 0;
  const sessionCostLocal = sessionCostUSD * cfg.usdToLocalRate;

  // ── From JSONL ────────────────────────────────────────────────────────────
  const allEntries = collectAllEntries(claudeDir);

  // 5h session: rolling window from oldest message in last 5 hours.
  // Reset = when that oldest message falls out of the window (oldest + 5h).
  // Displayed as a countdown to mirror Claude's "Resets in X hr Y min".
  const fiveHrAgo  = new Date(now - cfg.sessionWindowHours * 3_600_000);
  const win5h      = allEntries.filter(e => e.timestamp >= fiveHrAgo);
  const tokens5h   = win5h.reduce((s, e) => s + totalTokens(e.usage), 0);
  const pct5h      = pct(tokens5h, cfg.sessionLimitTokens);
  const reset5h    = win5h.length > 0
    ? new Date(win5h[0].timestamp.getTime() + cfg.sessionWindowHours * 3_600_000)
    : null;

  // Weekly: fixed day/time schedule — NOT a rolling window.
  // Matches claude.ai → Settings → Usage "Resets Sun 1:00 PM" format.
  const lastWeeklyReset = getLastWeeklyReset(
    now, TZ, cfg.weeklyResetDay, cfg.weeklyResetHour, cfg.weeklyResetMinute
  );
  const nextWeeklyReset = new Date(lastWeeklyReset.getTime() + 7 * 86_400_000);
  const winWeekly       = allEntries.filter(e => e.timestamp >= lastWeeklyReset);
  const tokensWeekly    = winWeekly.reduce((s, e) => s + totalTokens(e.usage), 0);
  const pctWeekly       = pct(tokensWeekly, cfg.weeklyLimitTokens);

  // Monthly spend
  const monthStart     = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthlyEntries = allEntries.filter(e => e.timestamp >= monthStart);
  const spendUSD       = monthlyEntries.reduce((s, e) => s + costUSD(e.usage, e.model, cfg.pricing), 0);
  const spendLocal     = spendUSD * cfg.usdToLocalRate;
  const capLocal       = cfg.monthlyCapUSD * cfg.usdToLocalRate;
  const leftLocal      = Math.max(0, capLocal - spendLocal);

  // ── Assemble ──────────────────────────────────────────────────────────────
  const sym = cfg.currencySymbol;
  const sep = c(C.dim, ' | ');

  const ctxStr  = `ctx ${c(usageColor(ctxUsedPct), `${fmtTokens(ctxUsed)}/${fmtTokens(ctxTotal)}`)} ${c(C.dim, `(${ctxUsedPct}%)`)}`;
  const costStr = `cost ${c(C.white, `${sym}${sessionCostLocal.toFixed(2)}`)}`;

  // Session: "5h 17% in 4h 18m" — countdown matches Claude's UI
  const str5h = `5h ${c(usageColor(pct5h), `${pct5h}%`)}` +
    (reset5h ? c(C.dim, ` ${fmtCountdown(reset5h, now)}`) : '');

  // Weekly: "7d 3% sun 1:00pm" — fixed schedule matches Claude's UI
  const str7d = `7d ${c(usageColor(pctWeekly), `${pctWeekly}%`)}` +
    c(C.dim, ` ${fmtWeeklyReset(cfg.weeklyResetDay, nextWeeklyReset)}`);

  const overCap  = spendLocal > capLocal;
  const extraStr = `extra ${c(overCap ? C.red : C.yellow, `${sym}${spendLocal.toFixed(2)}/${sym}${capLocal.toFixed(2)}`)} ${c(overCap ? C.red : C.green, `(${sym}${leftLocal.toFixed(2)} left)`)}`;

  const line1 = [c(C.cyan, modelName), ctxStr, costStr].join(sep);
  const line2 = [str5h, str7d, extraStr].join(sep);
  process.stdout.write(line1 + '\n' + line2 + '\n');
}

// Claude Code sends JSON data via stdin
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let data = null;
  try { data = JSON.parse(input); } catch {}
  main(data);
});

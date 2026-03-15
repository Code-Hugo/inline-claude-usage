#!/usr/bin/env node
'use strict';

/**
 * inline-claude-usage
 * Real-time Claude usage in your terminal status line.
 * https://github.com/Code-Hugo/inline-claude-usage
 */

const fs  = require('fs');
const path = require('path');
const os  = require('os');

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'inline-claude-usage.json');

const DEFAULTS = {
  currencySymbol: '€',
  usdToLocalRate: 0.92,
  monthlyCapUSD: 21.74,
  sessionLimitTokens: 500000,
  weeklyLimitTokens: 2500000,
  sessionWindowHours: 5,
  weeklyWindowDays: 7,
  pricing: {
    'claude-opus-4-6':           { input: 15.00, cacheRead: 1.50, cacheWrite: 18.75, output: 75.00 },
    'claude-sonnet-4-6':         { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
    'claude-sonnet-4-5':         { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
    'claude-haiku-4-5':          { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
    'claude-haiku-4-5-20251001': { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
  }
};

function loadConfig() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return DEFAULTS;
  }
}

// ── JSONL Reader (for 5h / 7d / monthly — not provided by Claude Code) ────────

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

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true
  }).toLowerCase();
}

function fmtDate(date) {
  const m = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  return `${m[date.getMonth()]} ${date.getDate()}`;
}

function fmtTokens(n) {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(claudeData) {
  const cfg      = loadConfig();
  const claudeDir = path.join(os.homedir(), '.claude');
  const now      = new Date();

  // ── From Claude Code stdin (accurate, no calculation needed) ──────────────
  const modelName      = claudeData?.model?.display_name || 'Claude';
  const ctxUsedPct     = Math.floor(claudeData?.context_window?.used_percentage || 0);
  const ctxTotal       = claudeData?.context_window?.context_window_size || 200_000;
  const ctxUsed        = claudeData?.context_window?.total_input_tokens || 0;
  const sessionCostUSD = claudeData?.cost?.total_cost_usd || 0;
  const sessionCostLocal = sessionCostUSD * cfg.usdToLocalRate;

  // ── From JSONL: 5h / 7d / monthly (not provided by Claude Code) ───────────
  const allEntries = collectAllEntries(claudeDir);

  // 5h rolling window
  const fiveHrAgo = new Date(now - cfg.sessionWindowHours * 3_600_000);
  const win5h     = allEntries.filter(e => e.timestamp >= fiveHrAgo);
  const tokens5h  = win5h.reduce((s, e) => s + totalTokens(e.usage), 0);
  const pct5h     = pct(tokens5h, cfg.sessionLimitTokens);
  const reset5h   = win5h.length > 0
    ? new Date(win5h[0].timestamp.getTime() + cfg.sessionWindowHours * 3_600_000)
    : null;

  // 7d rolling window
  const sevenDayAgo = new Date(now - cfg.weeklyWindowDays * 86_400_000);
  const win7d       = allEntries.filter(e => e.timestamp >= sevenDayAgo);
  const tokens7d    = win7d.reduce((s, e) => s + totalTokens(e.usage), 0);
  const pct7d       = pct(tokens7d, cfg.weeklyLimitTokens);
  const reset7d     = win7d.length > 0
    ? new Date(win7d[0].timestamp.getTime() + cfg.weeklyWindowDays * 86_400_000)
    : null;

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
  const str5h   = `5h ${c(usageColor(pct5h), `${pct5h}%`)}` + (reset5h ? c(C.dim, ` @${fmtTime(reset5h)}`) : '');
  const str7d   = `7d ${c(usageColor(pct7d), `${pct7d}%`)}` + (reset7d ? c(C.dim, ` @${fmtDate(reset7d)}, ${fmtTime(reset7d)}`) : '');

  const overCap  = spendLocal > capLocal;
  const extraStr = `extra ${c(overCap ? C.red : C.yellow, `${sym}${spendLocal.toFixed(2)}/${sym}${capLocal.toFixed(2)}`)} ${c(overCap ? C.red : C.green, `(${sym}${leftLocal.toFixed(2)} left)`)}`;

  // Two lines — each shorter so content survives narrow terminals
  const line1 = [c(C.cyan, modelName), ctxStr, costStr].join(sep);
  const line2 = [str5h, str7d, extraStr].join(sep);
  process.stdout.write(line1 + '\n' + line2 + '\n');
}

// Claude Code sends JSON data via stdin — read it then run
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  let data = null;
  try { data = JSON.parse(input); } catch {}
  main(data);
});

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
  currency: 'EUR',
  currencySymbol: '€',
  usdToLocalRate: 0.92,          // USD → EUR (update as needed)
  monthlyCapUSD: 21.74,          // ~€20.00 at 0.92 rate
  sessionLimitTokens: 500000,    // approx 5h window limit (configure for your plan)
  weeklyLimitTokens: 2500000,    // approx 7d window limit (configure for your plan)
  sessionWindowHours: 5,
  weeklyWindowDays: 7,
  pricing: {
    'claude-opus-4-6':      { input: 15.00, cacheRead: 1.50, cacheWrite: 18.75, output: 75.00 },
    'claude-sonnet-4-6':    { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
    'claude-sonnet-4-5':    { input:  3.00, cacheRead: 0.30, cacheWrite:  3.75, output: 15.00 },
    'claude-haiku-4-5':     { input:  0.80, cacheRead: 0.08, cacheWrite:  1.00, output:  4.00 },
    'claude-haiku-4-5-20251001': { input: 0.80, cacheRead: 0.08, cacheWrite: 1.00, output: 4.00 },
  }
};

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
            sessionId: e.sessionId || '',
            model:     e.message.model || 'claude-sonnet-4-6',
            usage:     e.message.usage,
          });
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* skip unreadable file */ }
  return entries;
}

function collectAllEntries(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const entries = [];
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const projectDir = path.join(projectsDir, project);
      let files;
      try { files = fs.readdirSync(projectDir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        entries.push(...parseJSONLFile(path.join(projectDir, file)));
      }
    }
  } catch { /* no projects dir */ }
  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Current session: most recently modified JSONL ─────────────────────────────

function getCurrentSessionEntries(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  let latestPath = null, latestMtime = 0;
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, project);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const fp = path.join(dir, file);
        try {
          const { mtimeMs } = fs.statSync(fp);
          if (mtimeMs > latestMtime) { latestMtime = mtimeMs; latestPath = fp; }
        } catch { /* skip */ }
      }
    }
  } catch { /* no projects dir */ }
  return latestPath ? parseJSONLFile(latestPath) : [];
}

// ── Calculations ──────────────────────────────────────────────────────────────

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

function fmtModel(modelId) {
  // "claude-sonnet-4-6" → "Sonnet 4.6"
  return modelId
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)(-\d+)?$/, ' $1.$2')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const cfg      = loadConfig();
  const claudeDir = path.join(os.homedir(), '.claude');
  const now      = new Date();

  const allEntries     = collectAllEntries(claudeDir);
  const sessionEntries = getCurrentSessionEntries(claudeDir);

  if (allEntries.length === 0) {
    process.stdout.write('claude: no usage data\n');
    return;
  }

  // Context window: sum of input-side tokens in the latest message of current session
  let ctxTokens    = 0;
  let currentModel = 'claude-sonnet-4-6';
  if (sessionEntries.length > 0) {
    const last   = sessionEntries[sessionEntries.length - 1];
    currentModel = last.model;
    ctxTokens    = (last.usage.input_tokens               || 0)
                 + (last.usage.cache_read_input_tokens     || 0)
                 + (last.usage.cache_creation_input_tokens || 0);
  }

  // Session cost (current session file)
  const sessionCostUSD   = sessionEntries.reduce((s, e) => s + costUSD(e.usage, e.model, cfg.pricing), 0);
  const sessionCostLocal = sessionCostUSD * cfg.usdToLocalRate;

  // 5h rolling window
  const fiveHrAgo        = new Date(now - cfg.sessionWindowHours * 3_600_000);
  const win5h            = allEntries.filter(e => e.timestamp >= fiveHrAgo);
  const tokens5h         = win5h.reduce((s, e) => s + totalTokens(e.usage), 0);
  const pct5h            = pct(tokens5h, cfg.sessionLimitTokens);
  const reset5h          = win5h.length > 0
    ? new Date(win5h[0].timestamp.getTime() + cfg.sessionWindowHours * 3_600_000)
    : null;

  // 7d rolling window
  const sevenDayAgo      = new Date(now - cfg.weeklyWindowDays * 86_400_000);
  const win7d            = allEntries.filter(e => e.timestamp >= sevenDayAgo);
  const tokens7d         = win7d.reduce((s, e) => s + totalTokens(e.usage), 0);
  const pct7d            = pct(tokens7d, cfg.weeklyLimitTokens);
  const reset7d          = win7d.length > 0
    ? new Date(win7d[0].timestamp.getTime() + cfg.weeklyWindowDays * 86_400_000)
    : null;

  // Monthly extra spend
  const monthStart       = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthlyEntries   = allEntries.filter(e => e.timestamp >= monthStart);
  const spendUSD         = monthlyEntries.reduce((s, e) => s + costUSD(e.usage, e.model, cfg.pricing), 0);
  const spendLocal       = spendUSD * cfg.usdToLocalRate;
  const capLocal         = cfg.monthlyCapUSD * cfg.usdToLocalRate;
  const leftLocal        = Math.max(0, capLocal - spendLocal);

  // ── Assemble output ────────────────────────────────────────────────────────
  const sym  = cfg.currencySymbol;
  const ctxW = 200_000; // all current Claude models have 200k context

  const ctxStr     = `ctx ${fmtTokens(ctxTokens)}/${fmtTokens(ctxW)} (${pct(ctxTokens, ctxW)}%)`;
  const costStr    = `cost ${sym}${sessionCostLocal.toFixed(2)}`;
  const str5h      = `5h ${pct5h}%` + (reset5h ? ` @${fmtTime(reset5h)}` : '');
  const str7d      = `7d ${pct7d}%` + (reset7d ? ` @${fmtDate(reset7d)}, ${fmtTime(reset7d)}` : '');
  const extraStr   = `extra ${sym}${spendLocal.toFixed(2)}/${sym}${capLocal.toFixed(2)} (${sym}${leftLocal.toFixed(2)} left)`;

  const line = [fmtModel(currentModel), ctxStr, costStr, str5h, str7d, extraStr].join(' | ');
  process.stdout.write(line + '\n');
}

main();

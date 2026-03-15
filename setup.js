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

const bold  = t => `\x1b[1m${t}\x1b[0m`;
const dim   = t => `\x1b[2m${t}\x1b[0m`;
const green = t => `\x1b[32m${t}\x1b[0m`;
const cyan  = t => `\x1b[36m${t}\x1b[0m`;
const yellow = t => `\x1b[33m${t}\x1b[0m`;

// ── Plan presets ──────────────────────────────────────────────────────────────

const PLANS = [
  {
    key: 'pro',
    label: 'Claude Pro',
    monthlyCapUSD: 20,
    sessionTokens: 88_000,
    weeklyTokens: 440_000,
    hasLimits: true,
    calibrate: false,
  },
  {
    key: 'max100',
    label: 'Claude Max ($100/mo)',
    monthlyCapUSD: 100,
    sessionTokens: 500_000,
    weeklyTokens: 2_500_000,
    hasLimits: true,
    calibrate: false,
  },
  {
    key: 'max200',
    label: 'Claude Max ($200/mo)',
    monthlyCapUSD: 200,
    sessionTokens: 1_000_000,
    weeklyTokens: 5_000_000,
    hasLimits: true,
    calibrate: false,
  },
  {
    key: 'team',
    label: 'Claude Team',
    monthlyCapUSD: null,
    sessionTokens: null,
    weeklyTokens: null,
    hasLimits: true,
    calibrate: true,     // limits vary by contract — calibration required
  },
  {
    key: 'api',
    label: 'Claude API (pay-as-you-go)',
    monthlyCapUSD: null,
    sessionTokens: null,
    weeklyTokens: null,
    hasLimits: false,
    calibrate: false,
  },
];

// ── Readline helpers ──────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

// ── Token counting for calibration ───────────────────────────────────────────

function countTokensInWindow(claudeDir, windowMs) {
  const projectsDir = path.join(claudeDir, 'projects');
  const cutoff = new Date(Date.now() - windowMs);
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
              total += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
                     + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  return total;
}

// ── Calibration flow ──────────────────────────────────────────────────────────

async function calibrate(rl, claudeDir) {
  const tokens5h = countTokensInWindow(claudeDir, 5 * 3_600_000);
  const tokens7d = countTokensInWindow(claudeDir, 7 * 86_400_000);

  console.log(`\n  Tokens detected in your local history:`);
  console.log(`    Last 5h : ${dim(tokens5h.toLocaleString())} tokens`);
  console.log(`    Last 7d : ${dim(tokens7d.toLocaleString())} tokens`);
  console.log(`\n  ${dim('Open claude.ai → Settings → Usage to find your current percentages.')}\n`);

  let sessionLimit, weeklyLimit;

  // ── 5h session ──────────────────────────────────────────────────────────
  if (tokens5h > 0) {
    const raw = await ask(rl, `  ${cyan('?')} Your current 5-hour session usage % ${dim('(0 to enter manually)')}: `);
    const p = parseFloat(raw);
    if (p > 0 && p <= 100) {
      sessionLimit = Math.round(tokens5h / (p / 100));
      console.log(`  ${green('✓')} 5h session limit estimated: ${dim(sessionLimit.toLocaleString())} tokens\n`);
    }
  } else {
    console.log(`  ${yellow('!')} No 5h token data found — enter limit manually.\n`);
  }

  if (!sessionLimit) {
    const raw = await ask(rl, `  ${cyan('?')} Enter 5h session limit in tokens ${dim('[500000]')}: `);
    sessionLimit = parseInt(raw, 10) || 500_000;
    console.log('');
  }

  // ── 7d weekly ───────────────────────────────────────────────────────────
  if (tokens7d > 0) {
    const raw = await ask(rl, `  ${cyan('?')} Your current 7-day weekly usage %   ${dim('(0 to enter manually)')}: `);
    const p = parseFloat(raw);
    if (p > 0 && p <= 100) {
      weeklyLimit = Math.round(tokens7d / (p / 100));
      console.log(`  ${green('✓')} 7d weekly limit estimated: ${dim(weeklyLimit.toLocaleString())} tokens\n`);
    }
  } else {
    console.log(`  ${yellow('!')} No 7d token data found — enter limit manually.\n`);
  }

  if (!weeklyLimit) {
    const raw = await ask(rl, `  ${cyan('?')} Enter 7d weekly limit in tokens ${dim('[2500000]')}: `);
    weeklyLimit = parseInt(raw, 10) || 2_500_000;
    console.log('');
  }

  return { sessionLimit, weeklyLimit };
}

// ── Patch ~/.claude/settings.json ─────────────────────────────────────────────

function patchSettings() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
  delete cfg.statusCommand;
  cfg.statusLine = { type: 'command', command: `node ${INDEX_PATH}` };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const claudeDir    = path.join(os.homedir(), '.claude');
  const isReconfig   = process.argv.includes('--reconfigure');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

  const existingPlan = PLANS.find(p => p.key === existing.plan);

  console.log('');
  console.log(bold(cyan('  inline-claude-usage  ·  Setup')));
  console.log(dim('  ──────────────────────────────────────────'));
  if (isReconfig || Object.keys(existing).length > 0) {
    console.log(yellow('  Reconfiguring — press Enter to keep existing values.\n'));
  } else {
    console.log(dim('  Takes about 1 minute.\n'));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── 1. Plan ───────────────────────────────────────────────────────────────
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

  // ── 2. Currency ───────────────────────────────────────────────────────────
  console.log(bold('  Step 2 — Currency\n'));
  const defSym  = existing.currencySymbol || '€';
  const defRate = existing.usdToLocalRate  || 0.92;

  const symRaw  = await ask(rl, `  ${cyan('?')} Currency symbol     ${dim(`[${defSym}]`)}: `);
  const sym     = symRaw || defSym;

  const rateRaw = await ask(rl, `  ${cyan('?')} USD → ${sym} rate       ${dim(`[${defRate}]`)}: `);
  const rate    = parseFloat(rateRaw) || defRate;
  console.log('');

  // ── 3. Monthly cap ────────────────────────────────────────────────────────
  console.log(bold('  Step 3 — Monthly spend cap\n'));

  let capUSD;
  const defCapLocal = existing.monthlyCapUSD
    ? (existing.monthlyCapUSD * rate).toFixed(0)
    : plan.monthlyCapUSD
      ? (plan.monthlyCapUSD * rate).toFixed(0)
      : null;

  const capRaw = await ask(rl,
    `  ${cyan('?')} Monthly cap in ${sym}${defCapLocal ? dim(` [${sym}${defCapLocal}]`) : ''}: `
  );
  const capLocal = parseFloat(capRaw) || (defCapLocal ? parseFloat(defCapLocal) : 0);
  capUSD = capLocal / rate;
  console.log('');

  // ── 4. Session & weekly limits ────────────────────────────────────────────
  let sessionLimitTokens = plan.sessionTokens || existing.sessionLimitTokens || 500_000;
  let weeklyLimitTokens  = plan.weeklyTokens  || existing.weeklyLimitTokens  || 2_500_000;

  if (plan.hasLimits) {
    console.log(bold('  Step 4 — Usage limits\n'));

    if (plan.calibrate) {
      // Team: calibration required, no presets
      console.log(`  ${yellow('Team plan limits vary by contract.')} We\'ll calibrate from your live usage.\n`);
      const result = await calibrate(rl, claudeDir);
      sessionLimitTokens = result.sessionLimit;
      weeklyLimitTokens  = result.weeklyLimit;
    } else {
      // Pro/Max: show preset defaults, offer optional calibration
      console.log(`  Preset defaults for ${plan.label}:`);
      console.log(`    5h session : ${dim(sessionLimitTokens.toLocaleString())} tokens`);
      console.log(`    7d weekly  : ${dim(weeklyLimitTokens.toLocaleString())} tokens`);
      console.log('');
      console.log(`  ${dim('Tip: calibrate for more accurate percentages (takes 30 seconds).')}`);
      const doCalibrate = await ask(rl, `  ${cyan('?')} Calibrate from live usage? ${dim('[y/N]')}: `);
      if (doCalibrate.toLowerCase() === 'y') {
        const result = await calibrate(rl, claudeDir);
        sessionLimitTokens = result.sessionLimit;
        weeklyLimitTokens  = result.weeklyLimit;
      } else {
        console.log('');
      }
    }
  }

  // ── 5. Weekly reset schedule ─────────────────────────────────────────────
  console.log(bold('  Step 5 — Weekly reset schedule\n'));
  console.log(`  ${dim('Open claude.ai → Settings → Usage and look for "Resets Sun 1:00 PM"')}`);
  console.log(`  ${dim('or similar. Enter exactly what it shows.\n')}`);

  const DOW_MAP = { sun:0, sunday:0, mon:1, monday:1, tue:2, tuesday:2,
                    wed:3, wednesday:3, thu:4, thursday:4, fri:5, friday:5, sat:6, saturday:6 };
  const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const existingResetDay  = existing.weeklyResetDay  ?? 0;
  const existingResetHour = existing.weeklyResetHour ?? 13;
  const existingResetMin  = existing.weeklyResetMinute ?? 0;
  const defResetStr = `${DOW_NAMES[existingResetDay]} ${existingResetHour % 12 || 12}:${String(existingResetMin).padStart(2,'0')} ${existingResetHour >= 12 ? 'PM' : 'AM'}`;

  let weeklyResetDay = existingResetDay;
  let weeklyResetHour = existingResetHour;
  let weeklyResetMinute = existingResetMin;

  const resetRaw = await ask(rl, `  ${cyan('?')} Weekly reset day & time ${dim(`[${defResetStr}]`)}: `);
  if (resetRaw.trim()) {
    // Parse "Sun 1:00 PM", "Sunday 13:00", "Mon 9:30 AM", etc.
    const lower = resetRaw.toLowerCase();
    const dayMatch = lower.match(/^(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)/);
    if (dayMatch) {
      weeklyResetDay = DOW_MAP[dayMatch[1]] ?? existingResetDay;
      const timeMatch = lower.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
      if (timeMatch) {
        let h = parseInt(timeMatch[1]);
        const m = parseInt(timeMatch[2]);
        const ampm = timeMatch[3];
        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        weeklyResetHour   = h;
        weeklyResetMinute = m;
      }
    } else {
      console.log(yellow(`  Could not parse "${resetRaw}" — keeping existing value.`));
    }
  }
  const resetLabel = `${DOW_NAMES[weeklyResetDay]} ${weeklyResetHour % 12 || 12}:${String(weeklyResetMinute).padStart(2,'0')} ${weeklyResetHour >= 12 ? 'PM' : 'AM'}`;
  console.log(`  ${green('✓')} Weekly reset: ${resetLabel}\n`);

  // ── 6. Display options ────────────────────────────────────────────────────
  console.log(bold('  Step 6 — Display\n'));
  const defDisabled = existing.disabled === true ? 'Y' : 'n';
  const disableRaw  = await ask(rl, `  ${cyan('?')} Disable status line? ${dim(`[${defDisabled}]`)}: `);
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

  // ── Patch Claude settings ─────────────────────────────────────────────────
  try {
    patchSettings();
    console.log(`  ${green('✓')} statusLine configured in ${dim(SETTINGS_PATH)}`);
  } catch (e) {
    console.log(`  ${yellow('!')} Could not update settings.json automatically.`);
    console.log(`    Add this manually to ~/.claude/settings.json:`);
    console.log(dim(`    "statusLine": { "type": "command", "command": "node ${INDEX_PATH}" }`));
  }

  console.log('');
  console.log(bold(green('  All done!')));
  if (disabled) {
    console.log(yellow('  Status line is currently disabled. Re-run setup to enable it.'));
  } else {
    console.log('  Restart Claude Code to see your status line.');
  }
  console.log('');
  console.log(dim('  To reconfigure at any time:'));
  console.log(dim(`  node ${path.join(__dirname, 'setup.js')} --reconfigure`));
  console.log('');
}

main().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

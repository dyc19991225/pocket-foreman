#!/usr/bin/env node
import path from 'node:path';
import { detectWorkers } from '../src/detector.mjs';
import { scanWorkspaceProjects } from '../src/scanner.mjs';
import { ForemanStore } from '../src/store.mjs';
import { createForemanServer } from '../src/server.mjs';
import { executeTask } from '../src/runner.mjs';
import { ApprovalNotifier } from '../src/notifier.mjs';

const args = process.argv.slice(2);
const cmd = args[0] || 'up';

function getFlag(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const dataDir = path.resolve(getFlag('--data-dir', path.join(process.cwd(), '.foreman')));
const port = Number(getFlag('--port', process.env.FOREMAN_PORT || '4788'));

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`
⚡ pocket-foreman v2.0 — Cross-CLI Coding Orchestrator, Autoloop & Telegram Remote

Usage:
  pocket-foreman up [--port 4788]             Start Mission Control Web UI + TG Remote Daemon
  pocket-foreman doctor                       Detect local Codex, Claude Code & Antigravity CLIs
  pocket-foreman projects [root-dir]          Scan & list local Git/Node/Python/Rust repositories
  pocket-foreman ledger                       Print token & USD cost breakdown from ledger.jsonl
  pocket-foreman submit "<goal>" [options]    Dispatch a background task from CLI
    --worker <codex|claude|agy>               Target CLI worker (default: codex)
    --race <codex,claude,agy>                 Run parallel git-worktree Arena Race!
    --write                                   Grant isolated git-worktree write permission
    --verify "<cmd>"                          Autoloop verification gate (e.g. "npm run build")
    --reviewer <auto|claude|codex|agy|none>   Cross-CLI independent code reviewer (default: auto)
    --workspace <dir>                         Target repository directory (default: cwd)
    --simulate                                Dry-run simulation without spending API quota
`);
  process.exit(0);
}

if (cmd === 'doctor') {
  const workers = detectWorkers(true);
  console.log('\n⚡ Pocket Foreman v2.0 — Local Coding CLI Discovery\n' + '─'.repeat(58));
  for (const w of Object.values(workers)) {
    const badge = w.installed ? '✓ READY  ' : '○ MISSING';
    console.log(`  [${badge}] ${w.displayName.padEnd(25)} ${w.version || ''}`);
    if (w.executable) console.log(`             ↳ ${w.executable}`);
  }
  console.log('─'.repeat(58) + '\n');
  process.exit(0);
}

if (cmd === 'projects') {
  const rootArg = args[1] ? path.resolve(args[1]) : path.dirname(process.cwd());
  const list = scanWorkspaceProjects([rootArg, process.cwd()]);
  console.log(`\n📂 Discovered Projects under ${rootArg} (${list.length})\n` + '─'.repeat(68));
  for (const p of list) {
    console.log(
      `  • ${p.name.padEnd(24)} [${p.kind.padEnd(6)}${p.branch ? ` · ${p.branch}` : ''}] ${p.suggestedVerifyCmd ? `-> verify: "${p.suggestedVerifyCmd}"` : ''}`
    );
  }
  console.log('');
  process.exit(0);
}

const store = new ForemanStore(dataDir);

if (cmd === 'ledger') {
  const stats = store.getStats();
  console.log(`\n📊 Pocket Foreman Ledger (${store.ledgerFile})\n` + '─'.repeat(58));
  console.log(`  Total Runs : ${stats.totalRuns}`);
  console.log(`  Total Cost : $${stats.totalCostUsd.toFixed(4)} USD`);
  console.log(`  Total Toks : ${stats.totalTokens.toLocaleString()}`);
  console.log('─'.repeat(58));
  for (const [k, v] of Object.entries(stats.byWorker)) {
    console.log(
      `  ${k.toUpperCase().padEnd(8)} | runs: ${String(v.runs).padStart(3)} | ok: ${String(v.ok).padStart(3)} | avg: ${String(v.avgSec + 's').padStart(6)} | $${v.costUsd.toFixed(4)}`
    );
  }
  console.log('');
  process.exit(0);
}

if (cmd === 'submit') {
  const goal = args[1];
  if (!goal || goal.startsWith('-')) {
    console.error('Error: Please provide a task goal: pocket-foreman submit "Fix login timeout"');
    process.exit(1);
  }
  const raceRaw = getFlag('--race', '');
  const workers = raceRaw ? raceRaw.split(',').map((s) => s.trim()) : [getFlag('--worker', 'codex')];
  const permission = args.includes('--write') ? 'write' : 'read-only';
  const simulate = args.includes('--simulate');
  const workspace = path.resolve(getFlag('--workspace', process.cwd()));
  const verifyCmd = getFlag('--verify', '');
  const reviewer = getFlag('--reviewer', 'auto');
  const notifier = new ApprovalNotifier(store, () => port);
  const raceGroupId = workers.length > 1 ? `RACE-${Date.now().toString(36).toUpperCase()}` : null;

  console.log(`🚀 Dispatching ${workers.length} worker(s) [${workers.join(', ')}] (${permission}, verify="${verifyCmd || 'none'}", reviewer=${reviewer})...`);
  const runs = workers.map((w) => {
    const task = {
      id: `${w.toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      raceGroupId,
      goal,
      prompt: getFlag('--prompt', goal),
      worker: w,
      workspace,
      permission,
      verifyCmd,
      maxRetries: 2,
      reviewer,
      simulate,
      allowShell: true,
      useWorktree: true,
      status: 'queued',
      createdAt: new Date().toISOString(),
    };
    store.upsertTask(task);
    return executeTask(task, store, notifier, () => {});
  });

  const finished = await Promise.all(runs);
  for (const t of finished) {
    console.log(
      `  [${t.status.toUpperCase()}] ${t.id} (${t.worker}) — ${t.durationSec}s · $${t.costUsd} · verify:${t.verifyStatus || 'n/a'} · review:${t.reviewScore ? `${t.reviewScore}/100` : 'n/a'}`
    );
  }
  process.exit(0);
}

// Default: `up`
const app = createForemanServer(store, port);
const info = await app.listen();
console.log(`
⚡ Pocket Foreman v2.0 Mission Control is LIVE!
──────────────────────────────────────────────────────────────
  🖥️  Desktop Dashboard : http://127.0.0.1:${info.port}/
  📱  Mobile Card Deck  : ${info.mobileUrl}
  📲  TG Remote Polling : ${app.tgDaemon.running ? 'ACTIVE (Zero-NAT)' : 'Standby (configure token in UI)'}
  📂  Ledger & Worktrees: ${dataDir}
──────────────────────────────────────────────────────────────
`);

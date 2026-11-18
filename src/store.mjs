import fs from 'node:fs';
import path from 'node:path';

export class ForemanStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.runsDir = path.join(this.dataDir, 'runs');
    this.worktreesDir = path.join(this.dataDir, 'worktrees');
    this.tasksFile = path.join(this.dataDir, 'tasks.json');
    this.ledgerFile = path.join(this.dataDir, 'ledger.jsonl');
    this.configFile = path.join(this.dataDir, 'config.json');

    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });

    if (!fs.existsSync(this.tasksFile)) {
      fs.writeFileSync(this.tasksFile, '[]\n', 'utf8');
    }
    if (!fs.existsSync(this.ledgerFile)) {
      fs.writeFileSync(this.ledgerFile, '', 'utf8');
    }
    if (!fs.existsSync(this.configFile)) {
      fs.writeFileSync(
        this.configFile,
        JSON.stringify(
          {
            telegramBotToken: '',
            telegramChatId: '',
            webhookUrl: '',
            defaultBudgetUsd: 2.0,
            defaultTimeoutSec: 600,
          },
          null,
          2
        ),
        'utf8'
      );
    }
  }

  getTasks() {
    try {
      return JSON.parse(fs.readFileSync(this.tasksFile, 'utf8'));
    } catch {
      return [];
    }
  }

  saveTasks(tasks) {
    fs.writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2), 'utf8');
  }

  getTask(id) {
    return this.getTasks().find((t) => t.id === id) ?? null;
  }

  upsertTask(task) {
    const tasks = this.getTasks();
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) tasks[idx] = task;
    else tasks.unshift(task);
    this.saveTasks(tasks);
    return task;
  }

  appendLedger(entry) {
    const record = { timestamp: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.ledgerFile, JSON.stringify(record) + '\n', 'utf8');
    return record;
  }

  getLedger() {
    if (!fs.existsSync(this.ledgerFile)) return [];
    return fs
      .readFileSync(this.ledgerFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  getStats() {
    const ledger = this.getLedger();
    const byWorker = {
      codex: { runs: 0, ok: 0, tokens: 0, costUsd: 0, avgSec: 0, totalSec: 0 },
      claude: { runs: 0, ok: 0, tokens: 0, costUsd: 0, avgSec: 0, totalSec: 0 },
      agy: { runs: 0, ok: 0, tokens: 0, costUsd: 0, avgSec: 0, totalSec: 0 },
    };
    let totalCostUsd = 0;
    let totalTokens = 0;

    for (const row of ledger) {
      const w = byWorker[row.worker] ?? (byWorker[row.worker] = { runs: 0, ok: 0, tokens: 0, costUsd: 0, avgSec: 0, totalSec: 0 });
      w.runs++;
      if (row.status === 'awaiting_approval' || row.status === 'completed' || row.status === 'merged') w.ok++;
      const tok = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      w.tokens += tok;
      w.costUsd += row.costUsd ?? 0;
      w.totalSec += row.durationSec ?? 0;
      w.avgSec = w.runs > 0 ? +(w.totalSec / w.runs).toFixed(1) : 0;

      totalCostUsd += row.costUsd ?? 0;
      totalTokens += tok;
    }

    return {
      totalRuns: ledger.length,
      totalCostUsd: +totalCostUsd.toFixed(4),
      totalTokens,
      byWorker,
    };
  }

  getConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch {
      return {};
    }
  }

  updateConfig(patch) {
    const next = { ...this.getConfig(), ...patch };
    fs.writeFileSync(this.configFile, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
}

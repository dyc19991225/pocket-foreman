import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectWorkers } from './detector.mjs';
import { createIsolatedWorktree, inspectWorkspaceDiff, isGitRepository } from './worktree.mjs';

const IS_WIN = process.platform === 'win32';

// Estimated fallback token pricing when CLI doesn't emit explicit USD cost
const TOKEN_RATES_PER_1M = {
  codex: { input: 1.75, cached: 0.25, output: 7.0 },
  claude: { input: 3.0, cached: 0.3, output: 15.0 },
  agy: { input: 1.25, cached: 0.15, output: 5.0 },
};

function estimateCostUsd(worker, inputTokens, cachedTokens, outputTokens, explicitUsd) {
  if (typeof explicitUsd === 'number' && explicitUsd > 0) return +explicitUsd.toFixed(4);
  const r = TOKEN_RATES_PER_1M[worker] ?? TOKEN_RATES_PER_1M.codex;
  const freshInput = Math.max(0, inputTokens - cachedTokens);
  const usd =
    (freshInput / 1_000_000) * r.input +
    (cachedTokens / 1_000_000) * r.cached +
    (outputTokens / 1_000_000) * r.output;
  return +usd.toFixed(4);
}

function buildWrappedPrompt(task, workDir) {
  const permNote =
    task.permission === 'write'
      ? 'WRITE ALLOWED inside workspace only. Do NOT run git commit, git push, or modify files outside workspace.'
      : 'READ-ONLY audit. Do NOT create, edit, or delete any files.';
  const acc =
    Array.isArray(task.acceptance) && task.acceptance.length > 0
      ? `\nAcceptance Criteria:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}\n`
      : '';
  return `# Task ${task.id}: ${task.goal}
Workspace: ${workDir}
Permission: ${permNote}${acc}
Instructions:
${task.prompt}

When finished, end with a concise summary (<20 lines): what changed, verification commands run, and any caveats.`;
}

function parseCodexJsonl(stdout) {
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let summary = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'turn.completed' && evt.usage) {
        inputTokens += evt.usage.input_tokens ?? 0;
        cachedTokens += evt.usage.cached_input_tokens ?? 0;
        outputTokens += evt.usage.output_tokens ?? 0;
      } else if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        summary = evt.item.text ?? summary;
      }
    } catch {
      // ignore non-json line
    }
  }
  return { inputTokens, cachedTokens, outputTokens, costUsd: null, summary };
}

function parseClaudeOrAgyJson(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{') || s.startsWith('['));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const obj = Array.isArray(parsed)
        ? parsed.findLast((x) => x?.type === 'result') ?? parsed[parsed.length - 1]
        : parsed;
      if (!obj) continue;
      const usage = obj.usage ?? {};
      return {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        cachedTokens: usage.cache_read_input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: obj.total_cost_usd ?? obj.cost_usd ?? null,
        summary: obj.result ?? obj.text ?? obj.response ?? '',
      };
    } catch {
      // try previous line
    }
  }
  return { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null, summary: stdout.slice(-1200) };
}

function quoteWinArg(arg) {
  if (arg === '') return '""';
  if (!/[\s",;=&|<>^()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function spawnWorkerProcess(exe, args, cwd, stdinText, timeoutSec, onLog) {
  return new Promise((resolve) => {
    const isCmd = IS_WIN && exe.toLowerCase().endsWith('.cmd');
    const file = isCmd ? 'cmd.exe' : exe;
    const finalArgs = isCmd
      ? ['/d', '/s', '/c', `"${quoteWinArg(exe)} ${args.map(quoteWinArg).join(' ')}"`]
      : args;

    const child = spawn(file, finalArgs, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: isCmd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (IS_WIN && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutSec * 1000);

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stdout += str;
      onLog?.(str);
    });
    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stderr += str;
      onLog?.(str);
    });

    if (stdinText) {
      child.stdin.write(stdinText, 'utf8');
    }
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, timedOut, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, timedOut: false, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

/**
 * Simulated execution used for instant Demo Races / offline testing without burning paid API quota.
 */
async function runSimulatedWorker(task, workDir, onLog) {
  const profiles = {
    codex: { delayMs: 1150, inTok: 6420, cacheTok: 4100, outTok: 980, style: 'compact bit-bucket token-bucket limiter' },
    claude: { delayMs: 1550, inTok: 8150, cacheTok: 5200, outTok: 1340, style: 'clean class-based sliding-window middleware with JSDoc' },
    agy: { delayMs: 980, inTok: 5890, cacheTok: 3900, outTok: 890, style: 'zero-allocation Map ring-buffer limiter + unit test' },
  };
  const prof = profiles[task.worker] ?? profiles.codex;

  const steps = [
    `[${task.worker}] Scanning workspace ${path.basename(workDir)}...`,
    `[${task.worker}] Planning ${prof.style}...`,
    `[${task.worker}] Applying patch & running verification check...`,
  ];

  for (const s of steps) {
    onLog?.(s + '\n');
    await new Promise((r) => setTimeout(r, prof.delayMs / 3));
  }

  if (task.permission === 'write') {
    const outFile = path.join(workDir, `rateLimiter.${task.worker}.ts`);
    const code = `/**
 * Generated by ${task.worker.toUpperCase()} in isolated git worktree (${task.branchName || 'local'})
 * Goal: ${task.goal}
 * Approach: ${prof.style}
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit = 60, private readonly windowMs = 60_000) {}

  public allow(clientKey: string, now = Date.now()): boolean {
    const cur = this.hits.get(clientKey);
    if (!cur || now >= cur.resetAt) {
      this.hits.set(clientKey, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (cur.count >= this.limit) return false;
    cur.count++;
    return true;
  }
}
`;
    fs.writeFileSync(outFile, code, 'utf8');
  }

  return {
    exitCode: 0,
    timedOut: false,
    inputTokens: prof.inTok,
    cachedTokens: prof.cacheTok,
    outputTokens: prof.outTok,
    costUsd: estimateCostUsd(task.worker, prof.inTok, prof.cacheTok, prof.outTok, null),
    summary: `Implemented ${prof.style} (${task.permission === 'write' ? `created rateLimiter.${task.worker}.ts` : 'completed read-only audit'}). All checks green.`,
  };
}

export async function executeTask(task, store, notifier, broadcast) {
  const startedMs = Date.now();
  const runDir = path.join(store.runsDir, `${task.id}-${startedMs}`);
  fs.mkdirSync(runDir, { recursive: true });

  // 1. Setup isolated git worktree if requested & workspace is a git repo
  let execDir = path.resolve(task.workspace);
  if (task.useWorktree !== false && task.permission === 'write' && isGitRepository(execDir)) {
    try {
      const wt = createIsolatedWorktree(execDir, store.worktreesDir, task.id);
      task.repoRoot = wt.repoRoot;
      task.branchName = wt.branchName;
      task.worktreePath = wt.worktreePath;
      execDir = wt.worktreePath;
    } catch (err) {
      task.worktreeNote = `Fallback to direct workspace (${err.message})`;
    }
  }

  task.status = 'running';
  task.startedAt = new Date().toISOString();
  task.logsTail = '';
  store.upsertTask(task);
  broadcast({ type: 'task_updated', task });

  const appendLog = (chunk) => {
    fs.appendFileSync(path.join(runDir, 'output.log'), chunk, 'utf8');
    task.logsTail = (task.logsTail + chunk).slice(-3500);
    broadcast({ type: 'task_log', taskId: task.id, chunk });
  };

  let result;
  if (task.simulate) {
    result = await runSimulatedWorker(task, execDir, appendLog);
  } else {
    const workers = detectWorkers();
    const wInfo = workers[task.worker];
    if (!wInfo?.installed || !wInfo.executable) {
      task.status = 'failed';
      task.error = `Worker CLI "${task.worker}" was not found on PATH. Install it or toggle Simulate mode.`;
      store.upsertTask(task);
      broadcast({ type: 'task_updated', task });
      return task;
    }

    const fullPrompt = buildWrappedPrompt(task, execDir);
    fs.writeFileSync(path.join(runDir, 'prompt.md'), fullPrompt, 'utf8');
    const finalMdPath = path.join(runDir, 'final.md');
    const timeoutSec = task.timeoutSec || store.getConfig().defaultTimeoutSec || 600;
    const budgetUsd = task.maxBudgetUsd || store.getConfig().defaultBudgetUsd || 2.0;

    let args = [];
    let stdinText = fullPrompt;

    if (task.worker === 'codex') {
      const sandbox = task.permission === 'write' ? 'workspace-write' : 'read-only';
      args = [
        'exec',
        '--cd',
        execDir,
        '--sandbox',
        sandbox,
        '--skip-git-repo-check',
        '-c',
        'approval_policy=never',
        '--json',
        '--output-last-message',
        finalMdPath,
        '-',
      ];
    } else if (task.worker === 'claude') {
      const tools =
        task.permission === 'write'
          ? task.allowShell
            ? 'Read,Glob,Grep,Edit,Write,Bash'
            : 'Read,Glob,Grep,Edit,Write'
          : 'Read,Glob,Grep';
      const mode = task.permission === 'write' ? 'acceptEdits' : 'default';
      args = [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        mode,
        '--tools',
        tools,
        '--max-turns',
        '35',
        '--max-budget-usd',
        String(budgetUsd),
        '--strict-mcp-config',
        '--disable-slash-commands',
      ];
    } else {
      // agy (Antigravity headless mode)
      stdinText = '';
      args = [
        '-p',
        fullPrompt.slice(0, 22000),
        '--output-format',
        'json',
        '--print-timeout',
        `${timeoutSec}s`,
        '--sandbox',
      ];
      if (task.permission === 'write') args.push('--dangerously-skip-permissions');
    }

    const proc = await spawnWorkerProcess(wInfo.executable, args, execDir, stdinText, timeoutSec, appendLog);
    const parsed =
      task.worker === 'codex' ? parseCodexJsonl(proc.stdout) : parseClaudeOrAgyJson(proc.stdout);
    const finalMd = fs.existsSync(finalMdPath) ? fs.readFileSync(finalMdPath, 'utf8') : '';

    result = {
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      inputTokens: parsed.inputTokens,
      cachedTokens: parsed.cachedTokens,
      outputTokens: parsed.outputTokens,
      costUsd: estimateCostUsd(
        task.worker,
        parsed.inputTokens,
        parsed.cachedTokens,
        parsed.outputTokens,
        parsed.costUsd
      ),
      summary: (finalMd || parsed.summary || proc.stderr.slice(-800)).trim(),
    };
  }

  const durationSec = +((Date.now() - startedMs) / 1000).toFixed(1);
  const diff = inspectWorkspaceDiff(execDir);

  task.durationSec = durationSec;
  task.inputTokens = result.inputTokens;
  task.cachedTokens = result.cachedTokens;
  task.outputTokens = result.outputTokens;
  task.costUsd = result.costUsd;
  task.summary = result.summary;
  task.changedFiles = diff.changedFiles;
  task.diffStat = diff.diffStat;
  task.diffPatch = diff.diffPatch;
  task.finishedAt = new Date().toISOString();

  if (result.timedOut || result.exitCode !== 0) {
    task.status = 'failed';
    task.error = result.timedOut ? 'Worker timed out' : `Exited with code ${result.exitCode}`;
  } else if (task.permission === 'write' && (diff.changedFiles.length > 0 || task.worktreePath)) {
    // Pause for 1-click human approval before merging into main branch!
    task.status = 'awaiting_approval';
  } else {
    task.status = 'completed';
  }

  store.upsertTask(task);
  store.appendLedger({
    taskId: task.id,
    raceGroupId: task.raceGroupId ?? null,
    goal: task.goal,
    worker: task.worker,
    simulate: Boolean(task.simulate),
    permission: task.permission,
    status: task.status,
    durationSec,
    inputTokens: task.inputTokens,
    cachedTokens: task.cachedTokens,
    outputTokens: task.outputTokens,
    costUsd: task.costUsd,
    changedCount: diff.changedFiles.length,
  });

  broadcast({ type: 'task_updated', task, stats: store.getStats() });

  if (task.status === 'awaiting_approval' || task.status === 'failed') {
    await notifier.sendApprovalCard(task);
  }

  return task;
}

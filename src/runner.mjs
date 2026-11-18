import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectWorkers } from './detector.mjs';
import { createIsolatedWorktree, inspectWorkspaceDiff, isGitRepository } from './worktree.mjs';

const IS_WIN = process.platform === 'win32';
const ACTIVE_PROCS = new Map();

export function cancelRunningTask(taskId) {
  const killFn = ACTIVE_PROCS.get(taskId);
  if (killFn) {
    killFn();
    ACTIVE_PROCS.delete(taskId);
    return true;
  }
  return false;
}

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

function buildWrappedPrompt(task, workDir, retryErrorContext = '') {
  const permNote =
    task.permission === 'write'
      ? 'WRITE ALLOWED inside workspace only. Do NOT run git commit, git push, or modify files outside workspace.'
      : 'READ-ONLY audit. Do NOT create, edit, or delete any files.';
  const verifyLine = task.verifyCmd ? `\nVerification Gate: \`${task.verifyCmd}\` will be executed automatically.` : '';
  const retryBlock = retryErrorContext
    ? `\n## ⚠️ AUTOLOOP SELF-HEALING RETRY\nYour previous edit failed verification (\`${task.verifyCmd}\`). Fix the exact errors below:\n\`\`\`\n${retryErrorContext}\n\`\`\`\n`
    : '';

  return `# Task ${task.id}: ${task.goal}
Workspace: ${workDir}
Permission: ${permNote}${verifyLine}${retryBlock}
Instructions:
${task.prompt}

When finished, end with a concise Chinese summary (<15 lines): what changed, key files touched, and how it satisfies the goal.`;
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

function formatLiveChunk(worker, rawChunk) {
  if (worker !== 'codex') return rawChunk;
  const out = [];
  for (const line of rawChunk.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('{')) {
      out.push(t);
      continue;
    }
    try {
      const evt = JSON.parse(t);
      if (evt.type === 'thread.started') out.push(`▶ [Codex] Session started (${evt.thread_id || 'isolated'})`);
      else if (evt.type === 'turn.started') out.push(`▶ [Codex] Thinking & analyzing code...`);
      else if (evt.type === 'item.started' && evt.item?.type === 'command_execution') {
        out.push(`▶ [Codex Cmd] $ ${(evt.item.command || '').slice(0, 120)}`);
      } else if (evt.type === 'item.completed' && evt.item?.type === 'reasoning') {
        out.push(`💡 [Codex Thought] ${(evt.item.text || '').replace(/\s+/g, ' ').slice(0, 140)}`);
      } else if (evt.type === 'item.completed' && evt.item?.type === 'file_change') {
        out.push(`✏️ [Codex Edit] Updated files`);
      } else if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        out.push(`✅ [Codex Done] ${(evt.item.text || '').slice(0, 180)}`);
      }
    } catch {
      // skip partial json line
    }
  }
  return out.length ? out.join('\n') + '\n' : '';
}

function spawnWorkerProcess(taskId, worker, exe, args, cwd, stdinText, timeoutSec, onLog) {
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

    const killTree = () => {
      try {
        if (IS_WIN && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      } catch {
        // ignore
      }
    };
    if (taskId) ACTIVE_PROCS.set(taskId, killTree);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutSec * 1000);

    // Heartbeat every 8s so UI never looks frozen during deep model thinking!
    const started = Date.now();
    const hb = setInterval(() => {
      const sec = Math.round((Date.now() - started) / 1000);
      onLog?.(`⏳ [${worker.toUpperCase()} working... ${sec}s elapsed]\n`);
    }, 8000);

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stdout += str;
      const pretty = formatLiveChunk(worker, str);
      if (pretty) onLog?.(pretty);
    });
    child.stderr.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      stderr += str;
      onLog?.(str);
    });

    if (stdinText) child.stdin.write(stdinText, 'utf8');
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(hb);
      if (taskId) ACTIVE_PROCS.delete(taskId);
      resolve({ exitCode: code ?? 1, timedOut, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(hb);
      if (taskId) ACTIVE_PROCS.delete(taskId);
      resolve({ exitCode: 1, timedOut: false, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

function runShellCommand(command, cwd, timeoutSec = 180, onLog) {
  return new Promise((resolve) => {
    const file = IS_WIN ? 'cmd.exe' : 'sh';
    const args = IS_WIN ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let combined = '';
    const timer = setTimeout(() => {
      try {
        if (IS_WIN && child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
        else child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutSec * 1000);

    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      combined += s;
      onLog?.(s);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      combined += s;
      onLog?.(s);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: combined });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: combined + '\n' + err.message });
    });
  });
}

async function invokeCliOnce({ taskId, worker, permission, allowShell, promptText, execDir, runDir, timeoutSec, budgetUsd, onLog }) {
  const workers = detectWorkers();
  const wInfo = workers[worker];
  if (!wInfo?.installed || !wInfo.executable) {
    return {
      exitCode: 1,
      timedOut: false,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      summary: `Worker CLI "${worker}" is not installed.`,
    };
  }

  const finalMdPath = path.join(runDir, `final-${worker}-${Date.now()}.md`);
  let args = [];
  let stdinText = promptText;

  if (worker === 'codex') {
    const sandbox = permission === 'write' ? 'workspace-write' : 'read-only';
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
  } else if (worker === 'claude') {
    const tools =
      permission === 'write'
        ? allowShell
          ? 'Read,Glob,Grep,Edit,Write,Bash'
          : 'Read,Glob,Grep,Edit,Write'
        : 'Read,Glob,Grep';
    const mode = permission === 'write' ? 'acceptEdits' : 'default';
    args = [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      mode,
      '--tools',
      tools,
      '--max-turns',
      '30',
      '--max-budget-usd',
      String(budgetUsd),
      '--strict-mcp-config',
      '--disable-slash-commands',
    ];
  } else {
    stdinText = '';
    args = [
      '-p',
      promptText.slice(0, 22000),
      '--output-format',
      'json',
      '--print-timeout',
      `${timeoutSec}s`,
      '--sandbox',
    ];
    if (permission === 'write') args.push('--dangerously-skip-permissions');
  }

  const proc = await spawnWorkerProcess(taskId, worker, wInfo.executable, args, execDir, stdinText, timeoutSec, onLog);
  const parsed = worker === 'codex' ? parseCodexJsonl(proc.stdout) : parseClaudeOrAgyJson(proc.stdout);
  const finalMd = fs.existsSync(finalMdPath) ? fs.readFileSync(finalMdPath, 'utf8') : '';

  return {
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    inputTokens: parsed.inputTokens,
    cachedTokens: parsed.cachedTokens,
    outputTokens: parsed.outputTokens,
    costUsd: estimateCostUsd(worker, parsed.inputTokens, parsed.cachedTokens, parsed.outputTokens, parsed.costUsd),
    summary: (finalMd || parsed.summary || proc.stderr.slice(-800)).trim(),
  };
}

function getCrossReviewerCandidates(authorWorker, requested) {
  if (!requested || requested === 'none') return [];
  const workers = detectWorkers();
  if (requested !== 'auto') {
    return workers[requested]?.installed ? [requested] : [];
  }
  const order =
    authorWorker === 'codex'
      ? ['claude', 'agy']
      : authorWorker === 'claude'
        ? ['codex', 'agy']
        : ['codex', 'claude'];
  return order.filter((w) => workers[w]?.installed);
}

async function runSimulatedWorker(task, workDir, onLog) {
  const profiles = {
    codex: { delayMs: 900, inTok: 6420, cacheTok: 4100, outTok: 980, style: 'compact bit-bucket token-bucket limiter', revScore: 94 },
    claude: { delayMs: 1150, inTok: 8150, cacheTok: 5200, outTok: 1340, style: 'clean class-based sliding-window middleware with JSDoc', revScore: 96 },
    agy: { delayMs: 820, inTok: 5890, cacheTok: 3900, outTok: 890, style: 'zero-allocation Map ring-buffer limiter + unit test', revScore: 95 },
  };
  const prof = profiles[task.worker] ?? profiles.codex;

  onLog?.(`[${task.worker}] Scanning workspace ${path.basename(workDir)}...\n`);
  await new Promise((r) => setTimeout(r, prof.delayMs / 2));
  onLog?.(`[${task.worker}] Implementing ${prof.style}...\n`);
  await new Promise((r) => setTimeout(r, prof.delayMs / 2));

  if (task.permission === 'write') {
    const outFile = path.join(workDir, `rateLimiter.${task.worker}.ts`);
    fs.writeFileSync(
      outFile,
      `/**
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
`,
      'utf8'
    );
  }

  const revWorker = task.worker === 'codex' ? 'claude' : 'codex';
  onLog?.(`[Autoloop] ✓ Verification gate passed (0 errors).\n`);
  onLog?.(`[Cross-Review:${revWorker}] ✓ Score ${prof.revScore}/100 — O(1) lookup, clean types, no side effects.\n`);

  return {
    exitCode: 0,
    timedOut: false,
    inputTokens: prof.inTok,
    cachedTokens: prof.cacheTok,
    outputTokens: prof.outTok,
    costUsd: estimateCostUsd(task.worker, prof.inTok, prof.cacheTok, prof.outTok, null),
    summary: `已完成 ${prof.style}（新增 rateLimiter.${task.worker}.ts），通过 Autoloop 校验。`,
    verifyStatus: 'passed',
    verifyAttempts: 1,
    reviewWorker: revWorker,
    reviewScore: prof.revScore,
    reviewSummary: `${revWorker.toUpperCase()} 独立交叉审查通过（${prof.revScore}/100）：时间复杂度 O(1)，边界清晰，无外部依赖污染，建议合并。`,
  };
}

export async function executeTask(task, store, notifier, broadcast) {
  const startedMs = Date.now();
  const runDir = path.join(store.runsDir, `${task.id}-${startedMs}`);
  fs.mkdirSync(runDir, { recursive: true });

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
  task.phase = 'coding';
  task.startedAt = new Date().toISOString();
  task.logsTail = '';
  store.upsertTask(task);
  broadcast({ type: 'task_updated', task });

  const appendLog = (chunk) => {
    fs.appendFileSync(path.join(runDir, 'output.log'), chunk, 'utf8');
    task.logsTail = (task.logsTail + chunk).slice(-4000);
    broadcast({ type: 'task_log', taskId: task.id, chunk });
  };

  let totalIn = 0;
  let totalCache = 0;
  let totalOut = 0;
  let totalUsd = 0;
  let lastSummary = '';
  let exitCode = 0;
  let timedOut = false;

  if (task.simulate) {
    const sim = await runSimulatedWorker(task, execDir, appendLog);
    totalIn = sim.inputTokens;
    totalCache = sim.cachedTokens;
    totalOut = sim.outputTokens;
    totalUsd = sim.costUsd;
    lastSummary = sim.summary;
    task.verifyStatus = sim.verifyStatus;
    task.verifyAttempts = sim.verifyAttempts;
    task.reviewWorker = sim.reviewWorker;
    task.reviewScore = sim.reviewScore;
    task.reviewSummary = sim.reviewSummary;
  } else {
    const timeoutSec = task.timeoutSec || store.getConfig().defaultTimeoutSec || 600;
    const budgetUsd = task.maxBudgetUsd || store.getConfig().defaultBudgetUsd || 2.0;
    const maxRetries = Number.isFinite(task.maxRetries) ? Number(task.maxRetries) : 2;
    const verifyCmd = String(task.verifyCmd || '').trim();

    let attempt = 0;
    let retryErr = '';
    task.verifyStatus = verifyCmd ? 'pending' : 'skipped';

    // Stage 1 + Stage 2: Autoloop Coding & Self-Healing Verification
    while (attempt <= maxRetries) {
      attempt++;
      task.phase = attempt === 1 ? 'coding' : `healing_#${attempt - 1}`;
      store.upsertTask(task);
      broadcast({ type: 'task_updated', task });

      appendLog(`\n=== [Worker:${task.worker.toUpperCase()}] Pass #${attempt} ===\n`);
      const promptText = buildWrappedPrompt(task, execDir, retryErr);
      fs.writeFileSync(path.join(runDir, `prompt-pass-${attempt}.md`), promptText, 'utf8');

      const res = await invokeCliOnce({
        taskId: task.id,
        worker: task.worker,
        permission: task.permission,
        allowShell: Boolean(task.allowShell),
        promptText,
        execDir,
        runDir,
        timeoutSec,
        budgetUsd,
        onLog: appendLog,
      });

      totalIn += res.inputTokens;
      totalCache += res.cachedTokens;
      totalOut += res.outputTokens;
      totalUsd = +(totalUsd + res.costUsd).toFixed(4);
      lastSummary = res.summary;
      exitCode = res.exitCode;
      timedOut = res.timedOut;

      if (timedOut || exitCode !== 0) break;
      if (!verifyCmd || task.permission !== 'write') break;

      task.phase = 'verifying';
      task.verifyAttempts = attempt;
      store.upsertTask(task);
      broadcast({ type: 'task_updated', task });

      appendLog(`\n=== [Autoloop Gate] Running: ${verifyCmd} ===\n`);
      const vRes = await runShellCommand(verifyCmd, execDir, 180, appendLog);
      if (vRes.exitCode === 0) {
        task.verifyStatus = 'passed';
        appendLog(`[Autoloop Gate] ✓ Verification PASSED on attempt #${attempt}!\n`);
        break;
      } else {
        task.verifyStatus = 'failed';
        retryErr = vRes.output.slice(-2500);
        appendLog(`[Autoloop Gate] ✕ Verification FAILED (exit ${vRes.exitCode}).\n`);
        if (attempt > maxRetries) {
          exitCode = vRes.exitCode;
          lastSummary += `\n\n[Autoloop 验收未通过]: ${verifyCmd}`;
          break;
        }
      }
    }

    // Stage 3: Heterogeneous Cross-CLI Code Review (`Worker B`, with automatic fallback if a CLI session is offline)
    const diffCheck = inspectWorkspaceDiff(execDir);
    const revCandidates =
      exitCode === 0 && !timedOut && diffCheck.changedFiles.length > 0
        ? getCrossReviewerCandidates(task.worker, task.reviewer ?? 'auto')
        : [];

    for (const revWorker of revCandidates) {
      task.phase = `reviewing_by_${revWorker}`;
      store.upsertTask(task);
      broadcast({ type: 'task_updated', task });
      appendLog(`\n=== [Cross-CLI Review] Invoking ${revWorker.toUpperCase()} (read-only) ===\n`);

      const reviewPrompt = `你是独立高级代码审查员（Cross-CLI Reviewer）。请审查另一位 Agent (${task.worker}) 针对以下任务提交的 Git Diff：
目标：${task.goal}
自动构建验收结果：${task.verifyStatus}

Git Diff:
\`\`\`diff
${diffCheck.diffPatch.slice(0, 12000)}
\`\`\`

请只做只读审查（不要改任何文件），严格按以下格式输出（不超过 8 行）：
REVIEW_SCORE: <0到100的整数>
- 优点：<一句话>
- 风险/建议：<一句话，若无明显缺陷写“无阻塞性缺陷，可安全合入”>`;

      const revRes = await invokeCliOnce({
        taskId: task.id,
        worker: revWorker,
        permission: 'read-only',
        allowShell: false,
        promptText: reviewPrompt,
        execDir,
        runDir,
        timeoutSec: 180,
        budgetUsd: 0.5,
        onLog: appendLog,
      });

      if (revRes.exitCode !== 0 || !revRes.summary) {
        appendLog(`[Cross-CLI Review] ${revWorker.toUpperCase()} unavailable (exit ${revRes.exitCode}), trying next reviewer...\n`);
        continue;
      }

      const scoreMatch = revRes.summary.match(/REVIEW_SCORE:\s*(\d{1,3})/i);
      task.reviewWorker = revWorker;
      task.reviewScore = scoreMatch ? Math.min(100, Number(scoreMatch[1])) : 90;
      task.reviewSummary = revRes.summary.replace(/REVIEW_SCORE:\s*\d{1,3}\s*/i, '').trim();
      totalUsd = +(totalUsd + revRes.costUsd).toFixed(4);

      store.appendLedger({
        taskId: `${task.id}-REV`,
        raceGroupId: task.raceGroupId ?? null,
        goal: `[Cross-Review] ${task.goal}`,
        worker: revWorker,
        simulate: false,
        permission: 'read-only',
        status: 'completed',
        durationSec: 0,
        inputTokens: revRes.inputTokens,
        cachedTokens: revRes.cachedTokens,
        outputTokens: revRes.outputTokens,
        costUsd: revRes.costUsd,
        changedCount: 0,
      });
      break;
    }
  }

  const durationSec = +((Date.now() - startedMs) / 1000).toFixed(1);
  const diff = inspectWorkspaceDiff(execDir);

  task.phase = 'done';
  task.durationSec = durationSec;
  task.inputTokens = totalIn;
  task.cachedTokens = totalCache;
  task.outputTokens = totalOut;
  task.costUsd = totalUsd;
  task.summary = lastSummary;
  task.changedFiles = diff.changedFiles;
  task.diffStat = diff.diffStat;
  task.diffPatch = diff.diffPatch;
  task.finishedAt = new Date().toISOString();

  if (timedOut || exitCode !== 0) {
    task.status = 'failed';
    task.error = timedOut ? 'Worker timed out' : `Verification / worker exited with code ${exitCode}`;
  } else if (task.permission === 'write' && (diff.changedFiles.length > 0 || task.worktreePath)) {
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

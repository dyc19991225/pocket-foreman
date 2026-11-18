import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectWorkers } from './detector.mjs';
import { scanWorkspaceProjects } from './scanner.mjs';
import { approveAndMergeWorktree, discardWorktree } from './worktree.mjs';
import { cancelRunningTask, executeTask } from './runner.mjs';
import { ApprovalNotifier } from './notifier.mjs';
import { TelegramRemoteDaemon } from './telegramDaemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function ensureDemoSandboxRepo(dataDir) {
  const demoRepo = path.join(dataDir, 'demo-sandbox-repo');
  if (!fs.existsSync(path.join(demoRepo, '.git'))) {
    fs.mkdirSync(demoRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: demoRepo, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(demoRepo, 'README.md'),
      '# Demo Sandbox API\n\nTarget repo for Pocket Foreman git-worktree multi-agent races.\n',
      'utf8'
    );
    execFileSync('git', ['add', '-A'], { cwd: demoRepo, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.name=Foreman', '-c', 'user.email=foreman@local', 'commit', '-m', 'chore: init sandbox'],
      { cwd: demoRepo, stdio: 'ignore' }
    );
  }
  return demoRepo;
}

export function createForemanServer(store, port = 4788) {
  let actualPort = port;
  const sseClients = new Set();
  const notifier = new ApprovalNotifier(store, () => actualPort);

  const broadcast = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const getScanRoots = () => {
    const cfg = store.getConfig();
    if (Array.isArray(cfg.scanRoots) && cfg.scanRoots.length > 0) return cfg.scanRoots;
    // Default: parent workspace directory (e.g. e:\ai) + current cwd
    return [path.dirname(process.cwd()), process.cwd()];
  };

  const dispatchBatch = async (body) => {
    const workersList =
      Array.isArray(body.workers) && body.workers.length > 0 ? body.workers : [body.worker || 'codex'];
    const goal = String(body.goal || '').trim();
    const prompt = String(body.prompt || goal).trim();
    const workspace = path.resolve(body.workspace || process.cwd());

    if (!goal) throw new Error('Missing task goal.');
    if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}`);

    const raceGroupId = workersList.length > 1 ? `RACE-${Date.now().toString(36).toUpperCase()}` : null;
    const created = [];

    for (const w of workersList) {
      const id = `${w.toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const task = {
        id,
        raceGroupId,
        goal,
        prompt,
        worker: w,
        workspace,
        permission: body.permission === 'write' ? 'write' : 'read-only',
        verifyCmd: String(body.verifyCmd || '').trim(),
        maxRetries: Number.isFinite(body.maxRetries) ? Number(body.maxRetries) : 2,
        reviewer: body.reviewer ?? 'auto',
        simulate: Boolean(body.simulate),
        allowShell: Boolean(body.allowShell),
        useWorktree: body.useWorktree !== false,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };
      store.upsertTask(task);
      created.push(task);
      void executeTask(task, store, notifier, broadcast);
    }
    return { created, raceGroupId };
  };

  const approveById = async (taskId) => {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    const mergeRes = approveAndMergeWorktree(task);
    task.status = 'merged';
    task.mergedCommit = mergeRes.commitSha ?? null;
    task.decidedAt = new Date().toISOString();
    store.upsertTask(task);
    broadcast({ type: 'task_updated', task });
    return { ok: true, task, mergeRes };
  };

  const discardById = async (taskId) => {
    const task = store.getTask(taskId);
    if (!task) throw new Error('Task not found');
    discardWorktree(task);
    task.status = 'discarded';
    task.decidedAt = new Date().toISOString();
    store.upsertTask(task);
    broadcast({ type: 'task_updated', task });
    return { ok: true, task };
  };

  const tgDaemon = new TelegramRemoteDaemon({
    store,
    getProjects: () => scanWorkspaceProjects(getScanRoots()),
    dispatchTask: async (opts) => (await dispatchBatch(opts)).created,
    approveById,
    discardById,
  });
  tgDaemon.syncWithConfig();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const projects = scanWorkspaceProjects(getScanRoots());
        return json(res, 200, {
          workers: detectWorkers(url.searchParams.get('refresh') === '1'),
          projects,
          tasks: store.getTasks(),
          stats: store.getStats(),
          mobileUrl: notifier.getMobileUrl(),
          tgRemoteActive: tgDaemon.running,
          defaultWorkspace: projects[0]?.path || process.cwd(),
          config: {
            ...store.getConfig(),
            telegramBotToken: store.getConfig().telegramBotToken ? '***configured***' : '',
          },
        });
      }

      if (req.method === 'POST' && pathname === '/api/tasks') {
        const body = await readJsonBody(req);
        const out = await dispatchBatch(body);
        return json(res, 201, out);
      }

      if (req.method === 'POST' && pathname === '/api/tasks/demo-race') {
        const demoRepo = ensureDemoSandboxRepo(store.dataDir);
        const out = await dispatchBatch({
          workers: ['codex', 'claude', 'agy'],
          goal: '实现高并发滑动窗口/令牌桶 API 限流器 (RateLimiter)',
          prompt: 'Create a clean TypeScript RateLimiter utility with O(1) memory per active client.',
          workspace: demoRepo,
          permission: 'write',
          simulate: true,
          reviewer: 'auto',
        });
        return json(res, 201, { ...out, demoRepo });
      }

      const approveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approveMatch) {
        return json(res, 200, await approveById(approveMatch[1]));
      }

      const discardMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/discard$/);
      if (req.method === 'POST' && discardMatch) {
        return json(res, 200, await discardById(discardMatch[1]));
      }

      const cancelMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        const taskId = cancelMatch[1];
        cancelRunningTask(taskId);
        const task = store.getTask(taskId);
        if (task) {
          task.status = 'failed';
          task.error = 'Cancelled by user';
          store.upsertTask(task);
          broadcast({ type: 'task_updated', task });
        }
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const patch = {};
        if (typeof body.telegramChatId === 'string') patch.telegramChatId = body.telegramChatId.trim();
        if (typeof body.webhookUrl === 'string') patch.webhookUrl = body.webhookUrl.trim();
        if (typeof body.scanRoot === 'string' && body.scanRoot.trim()) {
          patch.scanRoots = [body.scanRoot.trim()];
        }
        if (typeof body.telegramBotToken === 'string' && !body.telegramBotToken.includes('***')) {
          patch.telegramBotToken = body.telegramBotToken.trim();
        }
        store.updateConfig(patch);
        tgDaemon.syncWithConfig();
        return json(res, 200, { ok: true, tgRemoteActive: tgDaemon.running });
      }

      if (req.method === 'POST' && pathname === '/api/config/test-card') {
        const resCard = await notifier.sendApprovalCard({
          id: 'TEST-CARD',
          worker: 'codex',
          status: 'awaiting_approval',
          verifyStatus: 'passed',
          verifyAttempts: 1,
          reviewWorker: 'claude',
          reviewScore: 96,
          reviewSummary: '双向长轮询遥控已打通！在 Telegram 中可直接点击按钮合并或发 /task <项目名> <目标> 远程派单。',
          goal: 'Pocket Foreman v2.0 双向口袋遥控连通性测试',
          branchName: 'foreman/TEST-CARD',
          changedFiles: ['M src/index.ts'],
          durationSec: 4.2,
          costUsd: 0.0085,
          summary: 'Autoloop 验收全绿 + 异构双 CLI 交叉审查通过。',
        });
        return json(res, 200, resCard);
      }

      let fileRel = pathname === '/' || pathname === '/mobile' ? 'index.html' : pathname.slice(1);
      const safePath = path.normalize(path.join(UI_DIR, fileRel));
      if (!safePath.startsWith(UI_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const ext = path.extname(safePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(safePath));
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  return {
    server,
    tgDaemon,
    listen() {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(port, '0.0.0.0', () => {
          const addr = server.address();
          actualPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve({ port: actualPort, mobileUrl: notifier.getMobileUrl() });
        });
      });
    },
    close() {
      tgDaemon.stop();
      server.close();
    },
  };
}

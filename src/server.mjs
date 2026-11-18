import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectWorkers } from './detector.mjs';
import { approveAndMergeWorktree, discardWorktree } from './worktree.mjs';
import { executeTask } from './runner.mjs';
import { ApprovalNotifier } from './notifier.mjs';

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // 1. Real-time SSE stream
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

      // 2. Full system state
      if (req.method === 'GET' && pathname === '/api/state') {
        return json(res, 200, {
          workers: detectWorkers(url.searchParams.get('refresh') === '1'),
          tasks: store.getTasks(),
          stats: store.getStats(),
          mobileUrl: notifier.getMobileUrl(),
          defaultWorkspace: process.cwd(),
          config: {
            ...store.getConfig(),
            telegramBotToken: store.getConfig().telegramBotToken ? '***configured***' : '',
          },
        });
      }

      // 3. Submit single task OR parallel Multi-Agent Arena Race!
      if (req.method === 'POST' && pathname === '/api/tasks') {
        const body = await readJsonBody(req);
        const workersList = Array.isArray(body.workers) && body.workers.length > 0
          ? body.workers
          : [body.worker || 'codex'];
        const goal = String(body.goal || '').trim();
        const prompt = String(body.prompt || goal).trim();
        const workspace = path.resolve(body.workspace || process.cwd());

        if (!goal) return json(res, 400, { error: 'Missing task goal.' });
        if (!fs.existsSync(workspace)) return json(res, 400, { error: `Workspace not found: ${workspace}` });

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
            simulate: Boolean(body.simulate),
            allowShell: Boolean(body.allowShell),
            useWorktree: body.useWorktree !== false,
            status: 'queued',
            createdAt: new Date().toISOString(),
          };
          store.upsertTask(task);
          created.push(task);
          // Fire asynchronously in parallel worktrees!
          void executeTask(task, store, notifier, broadcast);
        }

        return json(res, 201, { created, raceGroupId });
      }

      // 4. 1-Click Simulated 3-Way Worktree Arena Race (Zero API cost, real git worktrees & diffs!)
      if (req.method === 'POST' && pathname === '/api/tasks/demo-race') {
        const demoRepo = ensureDemoSandboxRepo(store.dataDir);
        const raceGroupId = `RACE-${Date.now().toString(36).toUpperCase()}`;
        const goal = '实现高并发滑动窗口/令牌桶 API 限流器 (RateLimiter)';
        const prompt = 'Create a clean TypeScript RateLimiter utility with O(1) memory per active client.';
        const created = [];

        for (const w of ['codex', 'claude', 'agy']) {
          const task = {
            id: `${w.toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
            raceGroupId,
            goal,
            prompt,
            worker: w,
            workspace: demoRepo,
            permission: 'write',
            simulate: true,
            useWorktree: true,
            status: 'queued',
            createdAt: new Date().toISOString(),
          };
          store.upsertTask(task);
          created.push(task);
          void executeTask(task, store, notifier, broadcast);
        }

        return json(res, 201, { created, raceGroupId, demoRepo });
      }

      // 5. Approve & Merge isolated git worktree
      const approveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approveMatch) {
        const task = store.getTask(approveMatch[1]);
        if (!task) return json(res, 404, { error: 'Task not found' });

        const mergeRes = approveAndMergeWorktree(task);
        task.status = 'merged';
        task.mergedCommit = mergeRes.commitSha ?? null;
        task.decidedAt = new Date().toISOString();
        store.upsertTask(task);
        broadcast({ type: 'task_updated', task });
        return json(res, 200, { ok: true, task, mergeRes });
      }

      // 6. Discard / Reject worktree
      const discardMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/discard$/);
      if (req.method === 'POST' && discardMatch) {
        const task = store.getTask(discardMatch[1]);
        if (!task) return json(res, 404, { error: 'Task not found' });

        discardWorktree(task);
        task.status = 'discarded';
        task.decidedAt = new Date().toISOString();
        store.upsertTask(task);
        broadcast({ type: 'task_updated', task });
        return json(res, 200, { ok: true, task });
      }

      // 7. Save Telegram / Webhook notification config & test card
      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        const patch = {};
        if (typeof body.telegramChatId === 'string') patch.telegramChatId = body.telegramChatId.trim();
        if (typeof body.webhookUrl === 'string') patch.webhookUrl = body.webhookUrl.trim();
        if (typeof body.telegramBotToken === 'string' && !body.telegramBotToken.includes('***')) {
          patch.telegramBotToken = body.telegramBotToken.trim();
        }
        store.updateConfig(patch);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && pathname === '/api/config/test-card') {
        const resCard = await notifier.sendApprovalCard({
          id: 'TEST-CARD',
          worker: 'codex',
          status: 'awaiting_approval',
          goal: 'Pocket Foreman 手机拍板通知连通性测试',
          branchName: 'foreman/TEST-CARD',
          changedFiles: ['M src/index.ts'],
          durationSec: 4.2,
          costUsd: 0.0085,
          summary: 'Telegram / 飞书卡片推送正常工作！点击下方链接即可在手机浏览器审阅 Diff 并一键合并分支。',
        });
        return json(res, 200, resCard);
      }

      // 8. Static UI Serving (`/` Desktop Mission Control & `/mobile` Pocket Card Deck)
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
  };
}

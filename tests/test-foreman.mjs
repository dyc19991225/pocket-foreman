import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectWorkers } from '../src/detector.mjs';
import { ForemanStore } from '../src/store.mjs';
import { createForemanServer } from '../src/server.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-foreman-test-'));

try {
  // 1. CLI Detector structure check
  const workers = detectWorkers(true);
  assert.ok(workers.codex && workers.claude && workers.agy, 'Detector must return codex, claude, and agy entries');

  // 2. Start HTTP + SSE server on ephemeral port
  const store = new ForemanStore(path.join(tmpDir, '.foreman'));
  const app = createForemanServer(store, 0);
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;

  // 3. Trigger 3-way parallel git-worktree Arena Race
  const raceResp = await fetch(`${base}/api/tasks/demo-race`, { method: 'POST' }).then((r) => r.json());
  assert.equal(raceResp.created.length, 3, 'Demo race must spawn 3 parallel worker tasks');

  // Wait for simulated parallel worktree runs to reach awaiting_approval
  let state;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    state = await fetch(`${base}/api/state`).then((r) => r.json());
    if (state.tasks.every((t) => t.status === 'awaiting_approval')) break;
  }

  assert.equal(state.tasks.length, 3);
  for (const t of state.tasks) {
    assert.equal(t.status, 'awaiting_approval', `Task ${t.id} should pause at awaiting_approval`);
    assert.ok(t.branchName?.startsWith('foreman/'), 'Task should execute in isolated foreman/* branch');
    assert.ok(t.diffPatch.includes('export class RateLimiter'), 'Unified diff should capture generated TypeScript code');
  }
  assert.equal(state.stats.totalRuns, 3, 'Ledger should record all 3 runs');
  assert.ok(state.stats.totalTokens > 15000, 'Ledger should aggregate token usage');

  // 4. Approve winner & discard others -> verify real git merge into sandbox main!
  const winner = state.tasks[0];
  const mergeRes = await fetch(`${base}/api/tasks/${winner.id}/approve`, { method: 'POST' }).then((r) => r.json());
  assert.equal(mergeRes.ok, true);
  assert.equal(mergeRes.task.status, 'merged');
  assert.ok(mergeRes.task.mergedCommit, 'Approved worktree should produce a merge commit SHA');
  assert.ok(
    fs.existsSync(path.join(raceResp.demoRepo, `rateLimiter.${winner.worker}.ts`)),
    'Merged file must exist in main sandbox repo after approval!'
  );

  for (const loser of state.tasks.slice(1)) {
    const dRes = await fetch(`${base}/api/tasks/${loser.id}/discard`, { method: 'POST' }).then((r) => r.json());
    assert.equal(dRes.task.status, 'discarded');
  }

  app.server.close();
  console.log('✓ All Pocket Foreman E2E tests passed (CLI probe, 3-way git-worktree race, diff capture, ledger math & merge).');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

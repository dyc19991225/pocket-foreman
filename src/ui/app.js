const state = {
  locale: 'zh',
  mobileMode: window.location.pathname === '/mobile',
  workers: {},
  tasks: [],
  stats: { totalRuns: 0, totalCostUsd: 0, totalTokens: 0, byWorker: {} },
  mobileUrl: '',
  defaultWorkspace: '',
  config: {},
  selectedTaskId: null,
  formWorkers: new Set(['codex', 'claude']),
  permission: 'write',
  simulate: false,
  configModalOpen: false,
};

const appEl = document.getElementById('app');

async function api(path, method = 'GET', body = null) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function loadState() {
  const data = await api('/api/state');
  Object.assign(state, data);
  if (!state.selectedTaskId && state.tasks.length > 0) {
    state.selectedTaskId = state.tasks[0].id;
  }
  // Default simulate=true only if zero CLIs are installed locally
  const anyInstalled = Object.values(state.workers).some((w) => w.installed);
  if (!anyInstalled) state.simulate = true;
  render();
}

function connectSse() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'task_updated') {
        const idx = state.tasks.findIndex((t) => t.id === msg.task.id);
        if (idx >= 0) state.tasks[idx] = msg.task;
        else state.tasks.unshift(msg.task);
        if (msg.stats) state.stats = msg.stats;
        if (!state.selectedTaskId) state.selectedTaskId = msg.task.id;
        render();
      } else if (msg.type === 'task_log') {
        const t = state.tasks.find((x) => x.id === msg.taskId);
        if (t) {
          t.logsTail = ((t.logsTail || '') + msg.chunk).slice(-3500);
          if (state.selectedTaskId === t.id) {
            const logEl = document.getElementById('pf-live-log');
            if (logEl) logEl.textContent = t.logsTail;
          }
        }
      }
    } catch {
      // ignore
    }
  };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDiffHtml(patch) {
  if (!patch) return '<span style="color:var(--text-2)">No file modifications recorded.</span>';
  return patch
    .split(/\r?\n/)
    .map((ln) => {
      const esc = escapeHtml(ln);
      if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('@@')) {
        return `<span class="diff-hdr">${esc}</span>`;
      }
      if (ln.startsWith('+')) return `<span class="diff-add">${esc}</span>`;
      if (ln.startsWith('-')) return `<span class="diff-del">${esc}</span>`;
      return esc;
    })
    .join('\n');
}

async function triggerDemoRace() {
  const res = await api('/api/tasks/demo-race', 'POST');
  if (res.created?.[0]) state.selectedTaskId = res.created[0].id;
  await loadState();
}

async function approveTask(id) {
  await api(`/api/tasks/${id}/approve`, 'POST');
  await loadState();
}

async function discardTask(id) {
  await api(`/api/tasks/${id}/discard`, 'POST');
  await loadState();
}

function renderMobileDeck() {
  const zh = state.locale === 'zh';
  const pending = state.tasks.filter((t) => t.status === 'awaiting_approval');
  const recent = state.tasks.filter((t) => t.status !== 'awaiting_approval').slice(0, 8);

  appEl.innerHTML = `
    <div class="mobile-deck">
      <div class="topbar">
        <div class="brand">
          <div class="logo">PF</div>
          <span class="brand-name">📱 ${zh ? '口袋拍板卡片夹' : 'Pocket Approval Deck'}</span>
        </div>
        <div class="top-actions">
          <button class="btn btn-amber" id="m-demo">⚡ ${zh ? '赛马演示' : 'Demo Race'}</button>
          <button class="btn" id="m-desktop">🖥️</button>
        </div>
      </div>
      <div class="pane-body">
        <div style="font-size:12px;color:var(--amber);font-family:var(--mono);font-weight:800">
          🟡 ${zh ? `待你拍板合并 (${pending.length})` : `AWAITING YOUR APPROVAL (${pending.length})`}
        </div>
        ${
          pending.length === 0
            ? `<div class="stat-card" style="text-align:center;padding:24px;color:var(--text-2)">
                ${zh ? '当前没有卡住等待审批的任务，后台工头运转正常 ☕' : 'All clear! No tasks waiting on human approval ☕'}
              </div>`
            : pending
                .map(
                  (t) => `
              <div class="m-card">
                <div class="tc-row">
                  <span class="tc-id">${escapeHtml(t.id)} · ${escapeHtml(t.worker.toUpperCase())}</span>
                  <span style="font-family:var(--mono);font-size:11px;color:var(--amber)">$${(t.costUsd ?? 0).toFixed(4)} · ${t.durationSec ?? 0}s</span>
                </div>
                <div class="tc-goal">${escapeHtml(t.goal)}</div>
                <div style="font-size:12px;color:var(--text-1)">${escapeHtml(t.summary || '')}</div>
                <div class="diff-box" style="max-height:170px">${formatDiffHtml(t.diffPatch)}</div>
                <div class="tc-actions">
                  <button class="btn btn-emerald" style="flex:1;padding:10px" data-approve="${t.id}">
                    ✓ ${zh ? '批准并合并进主分支' : 'Approve & Merge'}
                  </button>
                  <button class="btn btn-crimson" style="padding:10px 14px" data-discard="${t.id}">
                    ✕ ${zh ? '丢弃' : 'Discard'}
                  </button>
                </div>
              </div>
            `
                )
                .join('')
        }

        <div style="font-size:12px;color:var(--text-2);font-family:var(--mono);margin-top:8px">
          ${zh ? '最近已处理记录' : 'RECENT DECISIONS'}
        </div>
        ${recent
          .map(
            (t) => `
          <div class="task-card ${t.status}">
            <div class="tc-row">
              <span class="tc-id">${escapeHtml(t.id)}</span>
              <span class="tc-status status-${t.status}">${t.status.toUpperCase()}</span>
            </div>
            <div class="tc-goal" style="font-size:12.5px">${escapeHtml(t.goal)}</div>
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;

  document.getElementById('m-demo').onclick = triggerDemoRace;
  document.getElementById('m-desktop').onclick = () => {
    state.mobileMode = false;
    window.history.pushState({}, '', '/');
    render();
  };
  appEl.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => approveTask(b.dataset.approve)));
  appEl.querySelectorAll('[data-discard]').forEach((b) => (b.onclick = () => discardTask(b.dataset.discard)));
}

function render() {
  if (state.mobileMode) {
    renderMobileDeck();
    return;
  }

  const zh = state.locale === 'zh';
  const pendingCount = state.tasks.filter((t) => t.status === 'awaiting_approval').length;
  const selected = state.tasks.find((t) => t.id === state.selectedTaskId) || state.tasks[0] || null;
  const bw = state.stats.byWorker || {};

  // Save current input values if re-rendering
  const prevGoal = document.getElementById('f-goal')?.value ?? '';
  const prevPrompt = document.getElementById('f-prompt')?.value ?? '';
  const prevWs = document.getElementById('f-ws')?.value || state.defaultWorkspace;

  appEl.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="logo">PF</div>
          <span class="brand-name">pocket-foreman</span>
          <div class="worker-pills">
            ${['codex', 'claude', 'agy']
              .map((k) => {
                const w = state.workers[k];
                return `<span class="w-pill ${w?.installed ? 'ready' : ''}">
                  ${w?.installed ? '●' : '○'} ${k.toUpperCase()} ${w?.installed ? 'READY' : 'NOT FOUND'}
                </span>`;
              })
              .join('')}
          </div>
        </div>
        <div class="top-actions">
          <button class="btn btn-amber" id="btn-demo-race">
            ⚔️ ${zh ? '一键三方 Worktree 赛马演示' : 'Run 3-Way Worktree Race Demo'}
          </button>
          <button class="btn" id="btn-mobile-view">
            📱 ${zh ? `手机拍板视图 (${pendingCount})` : `Mobile Deck (${pendingCount})`}
          </button>
          <button class="btn" id="btn-notify-cfg">
            🔔 ${zh ? 'TG / 飞书卡片配置' : 'Webhook / TG'}
          </button>
          <button class="btn" id="btn-lang">${zh ? 'EN' : '中文'}</button>
        </div>
      </header>

      <section class="stats-strip">
        <div class="stat-card">
          <div class="stat-k">${zh ? '待拍板合并 (PENDING)' : 'AWAITING APPROVAL'}</div>
          <div class="stat-v" style="color:var(--amber)">${pendingCount}</div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? '累计派单账本 (RUNS)' : 'TOTAL LEDGER RUNS'}</div>
          <div class="stat-v">${state.stats.totalRuns}</div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? '累计 Token 消耗' : 'TOTAL TOKENS'}</div>
          <div class="stat-v" style="color:var(--cyan)">${(state.stats.totalTokens || 0).toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? '累计估算花费 (USD)' : 'ESTIMATED SPEND'}</div>
          <div class="stat-v" style="color:var(--emerald)">$${(state.stats.totalCostUsd || 0).toFixed(4)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? '各 CLI 均耗对比 (CODEX / CLAUDE / AGY)' : 'AVG SPEED BY CLI'}</div>
          <div class="stat-v" style="font-size:13px;margin-top:6px">
            ${bw.codex?.avgSec ?? 0}s · ${bw.claude?.avgSec ?? 0}s · ${bw.agy?.avgSec ?? 0}s
          </div>
        </div>
      </section>

      <main class="board">
        <!-- Left: Dispatcher -->
        <section class="pane">
          <div class="pane-head">
            <span>🚀 ${zh ? '新建派单 / 多 CLI 赛马' : 'DISPATCH / ARENA RACE'}</span>
          </div>
          <div class="pane-body">
            <div class="field">
              <label>${zh ? '1. 选择出战 Worker（多选即自动开启并行 Worktree 赛马！）' : '1. Select Worker(s) (Multi-select = Parallel Worktree Race!)'}</label>
              <div class="worker-checks">
                ${['codex', 'claude', 'agy']
                  .map(
                    (w) => `
                  <div class="w-check ${state.formWorkers.has(w) ? 'checked' : ''}" data-fw="${w}">
                    ${w.toUpperCase()}
                  </div>
                `
                  )
                  .join('')}
              </div>
            </div>

            <div class="field">
              <label>${zh ? '2. 任务目标（一句话标题）' : '2. Task Goal'}</label>
              <input id="f-goal" value="${escapeHtml(prevGoal)}" placeholder="${zh ? '例如：给 API 路由加上滑动窗口限流并补单测' : 'e.g. Add sliding-window rate limiter + unit test'}" />
            </div>

            <div class="field">
              <label>${zh ? '3. 详细要求 / 验收标准' : '3. Detailed Prompt & Acceptance'}</label>
              <textarea id="f-prompt" rows="4" placeholder="${zh ? '背景、涉及哪些文件、跑什么测试命令验证...' : 'Context, files to touch, verification command...'}">${escapeHtml(prevPrompt)}</textarea>
            </div>

            <div class="field">
              <label>${zh ? '4. 目标仓库路径（自动创建独立 git worktree 互不污染）' : '4. Target Git Repo Path (auto-isolated via git worktree)'}</label>
              <input id="f-ws" value="${escapeHtml(prevWs)}" />
            </div>

            <div class="field">
              <label>${zh ? '5. 权限沙箱与运行模式' : '5. Sandbox & Execution Mode'}</label>
              <div style="display:flex;gap:6px">
                <button class="btn ${state.permission === 'write' ? 'btn-amber' : ''}" style="flex:1" id="f-perm-write">
                  ✍️ ${zh ? 'Worktree 隔离写' : 'Worktree Write'}
                </button>
                <button class="btn ${state.permission === 'read-only' ? 'btn-amber' : ''}" style="flex:1" id="f-perm-ro">
                  🔍 ${zh ? '只读审计' : 'Read-Only'}
                </button>
              </div>
              <label style="display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer;color:var(--text-1)">
                <input type="checkbox" id="f-sim" ${state.simulate ? 'checked' : ''} />
                ${zh ? '演练模拟模式（零 API 消耗测试完整 Worktree 审批流）' : 'Simulate Mode (0 API quota cost)'}
              </label>
            </div>

            <button class="btn btn-emerald" style="padding:11px;font-size:13px" id="btn-submit-task">
              ${
                state.formWorkers.size > 1
                  ? zh
                    ? `⚔️ 并发派发 ${state.formWorkers.size} 路赛马任务`
                    : `⚔️ Launch ${state.formWorkers.size}-Worker Arena Race`
                  : zh
                    ? '🚀 派发后台任务'
                    : '🚀 Dispatch Task'
              }
            </button>

            <div class="stat-card" style="font-size:11.5px;line-height:1.5;color:var(--text-2)">
              📱 <b>${zh ? '局域网手机秒开拍板地址：' : 'LAN Mobile Deck URL:'}</b><br/>
              <span style="font-family:var(--mono);color:var(--cyan)">${escapeHtml(state.mobileUrl)}</span>
            </div>
          </div>
        </section>

        <!-- Center: Queue & Approval Cards -->
        <section class="pane">
          <div class="pane-head">
            <span>📋 ${zh ? `任务队列与拍板中心 (${state.tasks.length})` : `TASK & APPROVAL QUEUE (${state.tasks.length})`}</span>
          </div>
          <div class="pane-body">
            ${
              state.tasks.length === 0
                ? `<div class="stat-card" style="text-align:center;padding:36px 18px;color:var(--text-2)">
                    <p style="font-size:14px;color:var(--text-0);font-weight:700;margin-bottom:8px">
                      ${zh ? '队列为空 — 点击右上角「⚔️ 一键三方 Worktree 赛马演示」立即体验！' : 'Queue empty — click "⚔️ Run 3-Way Worktree Race Demo" in the top bar!'}
                    </p>
                    <p style="font-size:12px">
                      ${zh ? '工头会自动在隔离的 git worktree 分支中并行拉起 Codex、Claude、Antigravity，算好耗时与账单，等你一键拍板合并胜出方案。' : 'Foreman spins up isolated git worktrees in parallel, measures tokens & speed, and waits for your 1-click merge.'}
                    </p>
                  </div>`
                : state.tasks
                    .map(
                      (t) => `
                  <div class="task-card ${t.status} ${selected?.id === t.id ? 'active' : ''}" data-tid="${t.id}">
                    <div class="tc-row">
                      <span class="tc-id">
                        ${escapeHtml(t.id)} · ${escapeHtml(t.worker.toUpperCase())}
                        ${t.raceGroupId ? `<small style="color:var(--amber)">[${escapeHtml(t.raceGroupId)}]</small>` : ''}
                      </span>
                      <span class="tc-status status-${t.status}">${t.status.toUpperCase()}</span>
                    </div>
                    <div class="tc-goal">${escapeHtml(t.goal)}</div>
                    <div class="tc-meta">
                      <span>🌿 ${escapeHtml(t.branchName || t.permission)}</span>
                      <span>⏱ ${t.durationSec ?? '...'}s</span>
                      <span>💰 $${(t.costUsd ?? 0).toFixed(4)}</span>
                      <span>📄 ${(t.changedFiles || []).length} files</span>
                    </div>
                    ${
                      t.status === 'awaiting_approval'
                        ? `<div class="tc-actions">
                            <button class="btn btn-emerald" data-approve="${t.id}">
                              ✓ ${zh ? '批准并合并分支 (Merge)' : 'Approve & Merge'}
                            </button>
                            <button class="btn btn-crimson" data-discard="${t.id}">
                              ✕ ${zh ? '打回丢弃' : 'Discard'}
                            </button>
                          </div>`
                        : ''
                    }
                  </div>
                `
                    )
                    .join('')
            }
          </div>
        </section>

        <!-- Right: Diff & Live Log Inspector -->
        <section class="pane">
          <div class="pane-head">
            <span>🔍 ${selected ? `${escapeHtml(selected.id)} · DIFF & LOGS` : 'INSPECTOR'}</span>
          </div>
          <div class="pane-body">
            ${
              !selected
                ? `<div style="color:var(--text-2);font-size:12.5px">${zh ? '点击中间任意任务卡片查看 Git Diff 补丁与实时终端输出。' : 'Select a task card to inspect its Git Diff and live worker logs.'}</div>`
                : `
                <div class="stat-card">
                  <div class="stat-k">${zh ? '执行者汇报摘要 (SUMMARY)' : 'WORKER SUMMARY'}</div>
                  <p style="font-size:12.5px;line-height:1.55;margin-top:6px;color:var(--text-0)">
                    ${escapeHtml(selected.summary || selected.error || (selected.status === 'running' ? 'Worker executing in isolated sandbox...' : '—'))}
                  </p>
                  ${
                    selected.mergedCommit
                      ? `<div style="margin-top:6px;font-family:var(--mono);font-size:11.5px;color:var(--emerald)">✓ Merged commit: ${escapeHtml(selected.mergedCommit)}</div>`
                      : ''
                  }
                </div>

                <div>
                  <div style="font-size:11.5px;font-family:var(--mono);color:var(--text-2);margin-bottom:5px">
                    GIT WORKTREE UNIFIED DIFF (${(selected.changedFiles || []).length} files)
                  </div>
                  <div class="diff-box" style="max-height:300px">${formatDiffHtml(selected.diffPatch)}</div>
                </div>

                <div>
                  <div style="font-size:11.5px;font-family:var(--mono);color:var(--text-2);margin-bottom:5px">
                    LIVE STREAMING TERMINAL TAIL
                  </div>
                  <pre class="diff-box" id="pf-live-log" style="max-height:200px;color:var(--text-1)">${escapeHtml(selected.logsTail || 'Waiting for output...')}</pre>
                </div>
              `
            }
          </div>
        </section>
      </main>
    </div>

    <!-- Telegram / Feishu Notification Config Modal -->
    <div class="modal-mask ${state.configModalOpen ? 'open' : ''}" id="pf-cfg-mask">
      <div class="modal-card">
        <div class="tc-row">
          <h3 style="font-size:15px">🔔 ${zh ? '手机卡片推送配置（Telegram / 飞书 / Discord）' : 'Mobile Approval Card Channels'}</h3>
          <button class="btn" id="btn-close-cfg">✕</button>
        </div>
        <div class="field">
          <label>Telegram Bot Token</label>
          <input id="cfg-tg-token" value="${escapeHtml(state.config.telegramBotToken || '')}" placeholder="123456:ABC-DEF..." />
        </div>
        <div class="field">
          <label>Telegram Chat ID</label>
          <input id="cfg-tg-chat" value="${escapeHtml(state.config.telegramChatId || '')}" placeholder="e.g. 10534xxxx" />
        </div>
        <div class="field">
          <label>${zh ? '飞书 / Discord / Slack Webhook URL（可选）' : 'Feishu / Discord / Slack Webhook URL'}</label>
          <input id="cfg-webhook" value="${escapeHtml(state.config.webhookUrl || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
        </div>
        <div class="tc-actions">
          <button class="btn btn-emerald" id="btn-save-cfg">${zh ? '保存配置' : 'Save'}</button>
          <button class="btn btn-amber" id="btn-test-cfg">${zh ? '发送测试拍板卡片' : 'Send Test Card'}</button>
        </div>
      </div>
    </div>
  `;

  // Wire events
  document.getElementById('btn-demo-race').onclick = triggerDemoRace;
  document.getElementById('btn-mobile-view').onclick = () => {
    state.mobileMode = true;
    window.history.pushState({}, '', '/mobile');
    render();
  };
  document.getElementById('btn-notify-cfg').onclick = () => {
    state.configModalOpen = true;
    render();
  };
  document.getElementById('btn-lang').onclick = () => {
    state.locale = state.locale === 'zh' ? 'en' : 'zh';
    render();
  };

  appEl.querySelectorAll('[data-fw]').forEach((el) => {
    el.onclick = () => {
      const w = el.dataset.fw;
      if (state.formWorkers.has(w) && state.formWorkers.size > 1) state.formWorkers.delete(w);
      else state.formWorkers.add(w);
      render();
    };
  });

  document.getElementById('f-perm-write').onclick = () => { state.permission = 'write'; render(); };
  document.getElementById('f-perm-ro').onclick = () => { state.permission = 'read-only'; render(); };
  document.getElementById('f-sim').onchange = (e) => { state.simulate = e.target.checked; };

  document.getElementById('btn-submit-task').onclick = async () => {
    const goal = document.getElementById('f-goal').value.trim();
    const prompt = document.getElementById('f-prompt').value.trim() || goal;
    const workspace = document.getElementById('f-ws').value.trim();
    if (!goal) return alert(zh ? '请填写任务目标！' : 'Please enter a task goal!');
    const res = await api('/api/tasks', 'POST', {
      workers: [...state.formWorkers],
      goal,
      prompt,
      workspace,
      permission: state.permission,
      simulate: state.simulate,
    });
    if (res.error) return alert(res.error);
    document.getElementById('f-goal').value = '';
    document.getElementById('f-prompt').value = '';
    if (res.created?.[0]) state.selectedTaskId = res.created[0].id;
    await loadState();
  };

  appEl.querySelectorAll('[data-tid]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('button')) return;
      state.selectedTaskId = card.dataset.tid;
      render();
    };
  });

  appEl.querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); void approveTask(b.dataset.approve); };
  });
  appEl.querySelectorAll('[data-discard]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); void discardTask(b.dataset.discard); };
  });

  const closeCfg = document.getElementById('btn-close-cfg');
  if (closeCfg) closeCfg.onclick = () => { state.configModalOpen = false; render(); };
  const saveCfg = document.getElementById('btn-save-cfg');
  if (saveCfg) {
    saveCfg.onclick = async () => {
      await api('/api/config', 'POST', {
        telegramBotToken: document.getElementById('cfg-tg-token').value,
        telegramChatId: document.getElementById('cfg-tg-chat').value,
        webhookUrl: document.getElementById('cfg-webhook').value,
      });
      state.configModalOpen = false;
      await loadState();
    };
  }
  const testCfg = document.getElementById('btn-test-cfg');
  if (testCfg) {
    testCfg.onclick = async () => {
      await api('/api/config', 'POST', {
        telegramBotToken: document.getElementById('cfg-tg-token').value,
        telegramChatId: document.getElementById('cfg-tg-chat').value,
        webhookUrl: document.getElementById('cfg-webhook').value,
      });
      const r = await api('/api/config/test-card', 'POST');
      alert(`Mobile Deck URL: ${r.mobileUrl}\nDeliveries: ${JSON.stringify(r.deliveries)}`);
    };
  }
}

void loadState();
connectSse();

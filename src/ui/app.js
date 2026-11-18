const state = {
  locale: 'zh',
  mobileMode: window.location.pathname === '/mobile',
  workers: {},
  projects: [],
  tasks: [],
  stats: { totalRuns: 0, totalCostUsd: 0, totalTokens: 0, byWorker: {} },
  mobileUrl: '',
  tgRemoteActive: false,
  defaultWorkspace: '',
  config: {},
  selectedTaskId: null,
  formWorkers: new Set(['codex']),
  selectedWorkspace: '',
  verifyCmd: '',
  reviewer: 'auto',
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
  if (!state.selectedWorkspace && state.projects.length > 0) {
    const pref = state.projects.find((p) => p.name === 'qq-speed-3d') || state.projects[0];
    state.selectedWorkspace = pref.path;
    state.verifyCmd = pref.suggestedVerifyCmd || '';
  }
  if (!state.selectedTaskId && state.tasks.length > 0) {
    state.selectedTaskId = state.tasks[0].id;
  }
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
          t.logsTail = ((t.logsTail || '') + msg.chunk).slice(-4000);
          if (state.selectedTaskId === t.id) {
            const logEl = document.getElementById('pf-live-log');
            if (logEl) {
              logEl.textContent = t.logsTail;
              logEl.scrollTop = logEl.scrollHeight;
            }
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

async function cancelTask(id) {
  await api(`/api/tasks/${id}/cancel`, 'POST');
  await loadState();
}

function getElapsedText(t) {
  if (typeof t.durationSec === 'number') return `${t.durationSec}s`;
  if (t.status === 'running' && t.startedAt) {
    const sec = Math.max(1, Math.round((Date.now() - new Date(t.startedAt).getTime()) / 1000));
    return `${sec}s ⏳`;
  }
  return '0s';
}

function renderQualityBadges(t) {
  const pills = [];
  if (t.status === 'running' && t.phase) {
    pills.push(`<span class="q-badge phase">⟳ ${escapeHtml(t.phase.toUpperCase())}</span>`);
  }
  if (t.verifyStatus === 'passed') {
    pills.push(`<span class="q-badge pass">✓ Autoloop 验收全绿 (${t.verifyAttempts || 1}轮)</span>`);
  }
  if (t.reviewScore) {
    pills.push(`<span class="q-badge rev">🛡️ ${escapeHtml((t.reviewWorker || '').toUpperCase())} 审查 ${t.reviewScore}/100</span>`);
  }
  return pills.length ? `<div class="tc-badges">${pills.join('')}</div>` : '';
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
          <span class="brand-name">📱 ${zh ? '口袋拍板卡片夹 v2.0' : 'Pocket Approval Deck'}</span>
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
                ${renderQualityBadges(t)}
                <div style="font-size:12px;color:var(--text-1)">${escapeHtml(t.summary || '')}</div>
                ${
                  t.reviewSummary
                    ? `<div style="font-size:11.5px;color:#d8b4fe;background:rgba(168,85,247,0.1);padding:7px 9px;border-radius:6px">${escapeHtml(t.reviewSummary)}</div>`
                    : ''
                }
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

  const prevGoal = document.getElementById('f-goal')?.value ?? '';
  const prevPrompt = document.getElementById('f-prompt')?.value ?? '';

  appEl.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="logo">PF</div>
          <span class="brand-name">pocket-foreman <small style="color:var(--emerald);font-size:11px">v2.0</small></span>
          <div class="worker-pills">
            ${['codex', 'claude', 'agy']
              .map((k) => {
                const w = state.workers[k];
                return `<span class="w-pill ${w?.installed ? 'ready' : ''}">
                  ${w?.installed ? '●' : '○'} ${k.toUpperCase()}
                </span>`;
              })
              .join('')}
            <span class="w-pill ${state.tgRemoteActive ? 'ready' : ''}">
              ${state.tgRemoteActive ? '📲 TG REMOTE ON' : '📲 TG STANDBY'}
            </span>
          </div>
        </div>
        <div class="top-actions">
          <button class="btn btn-amber" id="btn-demo-race">
            ⚔️ ${zh ? '一键三方赛马演示' : 'Demo 3-Way Race'}
          </button>
          <button class="btn" id="btn-mobile-view">
            📱 ${zh ? `手机拍板视图 (${pendingCount})` : `Mobile Deck (${pendingCount})`}
          </button>
          <button class="btn" id="btn-notify-cfg">
            📲 ${zh ? 'TG 双向遥控配置' : 'TG Remote Setup'}
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
          <div class="stat-k">${zh ? '已纳管工作盘项目' : 'DISCOVERED REPOS'}</div>
          <div class="stat-v" style="color:#d8b4fe">${state.projects.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? '累计派单账本 (RUNS)' : 'TOTAL LEDGER RUNS'}</div>
          <div class="stat-v">${state.stats.totalRuns}</div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? '累计花费 / Tokens' : 'SPEND / TOKENS'}</div>
          <div class="stat-v" style="color:var(--emerald);font-size:15px">
            $${(state.stats.totalCostUsd || 0).toFixed(4)} <small style="color:var(--text-2)">(${(state.stats.totalTokens || 0).toLocaleString()})</small>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-k">${zh ? 'CLI 均耗 (CODEX / CLAUDE / AGY)' : 'AVG SPEED BY CLI'}</div>
          <div class="stat-v" style="font-size:13px;margin-top:6px">
            ${bw.codex?.avgSec ?? 0}s · ${bw.claude?.avgSec ?? 0}s · ${bw.agy?.avgSec ?? 0}s
          </div>
        </div>
      </section>

      <main class="board">
        <!-- Left: v2.0 Pipeline Dispatcher -->
        <section class="pane">
          <div class="pane-head">
            <span>🚀 ${zh ? '派单台（项目扫描 + Autoloop + 异构互审）' : 'PIPELINE DISPATCHER'}</span>
          </div>
          <div class="pane-body">
            <div class="field">
              <label>${zh ? `1. 选择目标项目（自动扫描发现 ${state.projects.length} 个本地项目）` : `1. Target Project (${state.projects.length} Auto-Scanned)`}</label>
              <select id="f-proj-select">
                ${state.projects
                  .map(
                    (p) => `
                  <option value="${escapeHtml(p.path)}" ${p.path === state.selectedWorkspace ? 'selected' : ''}>
                    📂 ${escapeHtml(p.name)} [${p.kind}${p.branch ? ` · ${p.branch}` : ''}]
                  </option>
                `
                  )
                  .join('')}
              </select>
              <input id="f-ws" value="${escapeHtml(state.selectedWorkspace)}" style="font-family:var(--mono);font-size:11px" />
            </div>

            <div class="field">
              <label>${zh ? '2. 出战编码 Worker（多选自动开启并行 Worktree 赛马）' : '2. Coding Worker(s) (Multi = Parallel Worktree Race)'}</label>
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
              <label>${zh ? '3. 任务目标与详细要求' : '3. Task Goal & Detailed Prompt'}</label>
              <input id="f-goal" value="${escapeHtml(prevGoal)}" placeholder="${zh ? '一句话任务目标...' : 'Concise task goal...'}" />
              <textarea id="f-prompt" rows="3" placeholder="${zh ? '涉及哪些文件、约束条件...' : 'Files to touch, constraints...'}">${escapeHtml(prevPrompt)}</textarea>
            </div>

            <div class="field">
              <label>🔁 ${zh ? '4. Autoloop 自动验收门禁（报错自动喂回自愈重修）' : '4. Autoloop Verification Gate (Self-Healing)'}</label>
              <input id="f-verify" value="${escapeHtml(state.verifyCmd)}" placeholder="e.g. npm run build" style="font-family:var(--mono)" />
            </div>

            <div class="field">
              <label>🛡️ ${zh ? '5. 异构双 Agent 交叉 Code Review' : '5. Cross-CLI Independent Reviewer'}</label>
              <select id="f-reviewer">
                <option value="auto" ${state.reviewer === 'auto' ? 'selected' : ''}>AUTO（自动选另一家不同厂商 CLI 独立审查打分）</option>
                <option value="claude" ${state.reviewer === 'claude' ? 'selected' : ''}>Claude Code (Read-Only Reviewer)</option>
                <option value="codex" ${state.reviewer === 'codex' ? 'selected' : ''}>OpenAI Codex (Read-Only Reviewer)</option>
                <option value="agy" ${state.reviewer === 'agy' ? 'selected' : ''}>Google Antigravity (Read-Only Reviewer)</option>
                <option value="none" ${state.reviewer === 'none' ? 'selected' : ''}>关闭交叉审查</option>
              </select>
            </div>

            <div class="field">
              <div style="display:flex;gap:6px">
                <button class="btn ${state.permission === 'write' ? 'btn-amber' : ''}" style="flex:1" id="f-perm-write">
                  ✍️ ${zh ? 'Worktree 隔离写' : 'Worktree Write'}
                </button>
                <button class="btn ${state.permission === 'read-only' ? 'btn-amber' : ''}" style="flex:1" id="f-perm-ro">
                  🔍 ${zh ? '只读审计' : 'Read-Only'}
                </button>
              </div>
              <label style="display:flex;align-items:center;gap:6px;margin-top:4px;cursor:pointer;color:var(--text-1);font-size:11.5px">
                <input type="checkbox" id="f-sim" ${state.simulate ? 'checked' : ''} />
                ${zh ? '演练模拟模式（不调真实 CLI API）' : 'Simulate Mode (0 API quota)'}
              </label>
            </div>

            <button class="btn btn-emerald" style="padding:11px;font-size:13px" id="btn-submit-task">
              ${
                state.formWorkers.size > 1
                  ? zh
                    ? `⚔️ 并发启动 ${state.formWorkers.size} 路流水线赛马`
                    : `⚔️ Launch ${state.formWorkers.size}-Way Pipeline Race`
                  : zh
                    ? '🚀 启动真实 Worktree + Autoloop 流水线'
                    : '🚀 Launch Worktree + Autoloop Pipeline'
              }
            </button>
          </div>
        </section>

        <!-- Center: Queue & Approval Cards -->
        <section class="pane">
          <div class="pane-head">
            <span>📋 ${zh ? `流水线队列与拍板中心 (${state.tasks.length})` : `PIPELINE & APPROVAL QUEUE (${state.tasks.length})`}</span>
          </div>
          <div class="pane-body">
            ${state.tasks
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
                ${renderQualityBadges(t)}
                <div class="tc-meta" style="margin-top:6px">
                  <span>🌿 ${escapeHtml(t.branchName || t.permission)}</span>
                  <span data-live-timer="${t.id}">⏱ ${getElapsedText(t)}</span>
                  <span>💰 $${(t.costUsd ?? 0).toFixed(4)}</span>
                  <span>📄 ${(t.changedFiles || []).length} files</span>
                </div>
                ${
                  t.status === 'running'
                    ? `<div class="tc-actions">
                        <button class="btn btn-crimson" data-cancel="${t.id}">⏹ ${zh ? '中止运行' : 'Cancel'}</button>
                      </div>`
                    : ''
                }
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
              .join('')}
          </div>
        </section>

        <!-- Right: Diff, Cross-Review & Live Log Inspector -->
        <section class="pane">
          <div class="pane-head">
            <span>🔍 ${selected ? `${escapeHtml(selected.id)} · REVIEW, DIFF & LOGS` : 'INSPECTOR'}</span>
          </div>
          <div class="pane-body">
            ${
              !selected
                ? `<div style="color:var(--text-2);font-size:12.5px">Select a task card to inspect review score, unified diff, and live terminal logs.</div>`
                : `
                <div class="stat-card">
                  <div class="stat-k">${zh ? '执行者汇报摘要 (AUTHOR SUMMARY)' : 'AUTHOR SUMMARY'}</div>
                  <p style="font-size:12.5px;line-height:1.55;margin-top:6px;color:var(--text-0);white-space:pre-wrap">${escapeHtml(
                    selected.summary || selected.error || (selected.status === 'running' ? `Running stage: ${selected.phase || 'coding'}...` : '—')
                  )}</p>
                  ${
                    selected.mergedCommit
                      ? `<div style="margin-top:6px;font-family:var(--mono);font-size:11.5px;color:var(--emerald)">✓ Merged commit: ${escapeHtml(selected.mergedCommit)}</div>`
                      : ''
                  }
                </div>

                ${
                  selected.reviewSummary
                    ? `<div class="stat-card" style="border-color:rgba(168,85,247,0.5);background:rgba(168,85,247,0.06)">
                        <div class="stat-k" style="color:#d8b4fe">
                          🛡️ ${escapeHtml((selected.reviewWorker || '').toUpperCase())} 异构独立审查 (${selected.reviewScore}/100)
                        </div>
                        <p style="font-size:12px;line-height:1.55;margin-top:5px;color:var(--text-0);white-space:pre-wrap">${escapeHtml(selected.reviewSummary)}</p>
                      </div>`
                    : ''
                }

                <div>
                  <div style="font-size:11.5px;font-family:var(--mono);color:var(--text-2);margin-bottom:5px">
                    GIT WORKTREE UNIFIED DIFF (${(selected.changedFiles || []).length} files)
                  </div>
                  <div class="diff-box" style="max-height:260px">${formatDiffHtml(selected.diffPatch)}</div>
                </div>

                <div>
                  <div style="font-size:11.5px;font-family:var(--mono);color:var(--text-2);margin-bottom:5px">
                    LIVE STREAMING PIPELINE LOG
                  </div>
                  <pre class="diff-box" id="pf-live-log" style="max-height:180px;color:var(--text-1)">${escapeHtml(selected.logsTail || 'Waiting for output...')}</pre>
                </div>
              `
            }
          </div>
        </section>
      </main>
    </div>

    <!-- Telegram Bidirectional Remote Config Modal -->
    <div class="modal-mask ${state.configModalOpen ? 'open' : ''}" id="pf-cfg-mask">
      <div class="modal-card">
        <div class="tc-row">
          <h3 style="font-size:15px">📲 ${zh ? '免公网穿透 Telegram 双向遥控 & Webhook' : 'Zero-NAT Telegram Bidirectional Remote'}</h3>
          <button class="btn" id="btn-close-cfg">✕</button>
        </div>
        <p style="font-size:12px;color:var(--text-2);line-height:1.5">
          ${zh ? '填入 Bot Token 后，工头自动启动后台 HTTPS 长轮询：你在外面用手机给机器人发 /projects 或 /task qq-speed-3d <需求> 即可远程派单，完工卡片自带 [✅ 批准合并] 回调按钮！' : 'Save Bot Token to enable zero-NAT long-polling: send /projects or /task <repo> <goal> from your phone and tap inline Merge buttons directly in Telegram!'}
        </p>
        <div class="field">
          <label>Telegram Bot Token</label>
          <input id="cfg-tg-token" value="${escapeHtml(state.config.telegramBotToken || '')}" placeholder="123456:ABC-DEF..." />
        </div>
        <div class="field">
          <label>Authorized Telegram Chat ID</label>
          <input id="cfg-tg-chat" value="${escapeHtml(state.config.telegramChatId || '')}" placeholder="e.g. 10534xxxx" />
        </div>
        <div class="field">
          <label>${zh ? '飞书 / Discord / Slack Webhook URL（可选）' : 'Feishu / Discord / Slack Webhook URL'}</label>
          <input id="cfg-webhook" value="${escapeHtml(state.config.webhookUrl || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
        </div>
        <div class="tc-actions">
          <button class="btn btn-emerald" id="btn-save-cfg">${zh ? '保存并启用长轮询' : 'Save & Activate'}</button>
          <button class="btn btn-amber" id="btn-test-cfg">${zh ? '发送测试拍板按钮卡' : 'Send Test Card'}</button>
        </div>
      </div>
    </div>
  `;

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

  document.getElementById('f-proj-select').onchange = (e) => {
    state.selectedWorkspace = e.target.value;
    const hit = state.projects.find((p) => p.path === state.selectedWorkspace);
    if (hit) state.verifyCmd = hit.suggestedVerifyCmd || '';
    render();
  };
  document.getElementById('f-ws').oninput = (e) => { state.selectedWorkspace = e.target.value; };
  document.getElementById('f-verify').oninput = (e) => { state.verifyCmd = e.target.value; };
  document.getElementById('f-reviewer').onchange = (e) => { state.reviewer = e.target.value; };

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
    const verifyCmd = document.getElementById('f-verify').value.trim();
    if (!goal) return alert(zh ? '请填写任务目标！' : 'Please enter a task goal!');
    const res = await api('/api/tasks', 'POST', {
      workers: [...state.formWorkers],
      goal,
      prompt,
      workspace,
      verifyCmd,
      reviewer: state.reviewer,
      allowShell: true,
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
  appEl.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); void cancelTask(b.dataset.cancel); };
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
setInterval(() => {
  for (const t of state.tasks) {
    if (t.status === 'running') {
      const el = document.querySelector(`[data-live-timer="${t.id}"]`);
      if (el) el.textContent = `⏱ ${getElapsedText(t)}`;
    }
  }
}, 1000);
